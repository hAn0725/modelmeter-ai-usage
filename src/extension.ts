/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TreeProvider } from './tree/treeProvider';
import { ModelMeterSidebarProvider } from './tokenUsage/modelMeterSidebar';
import { TreeNode } from './tree/treeTypes';
import { registerNodeActions, setExtensionPath, setTreeRefresher } from './tree/nodeActions';
import { TokenUsageTracker } from './tokenUsage/tokenUsageTracker';
import { TokenUsageStatusBar } from './tokenUsage/tokenUsageStatusBar';
import { TokenUsageDashboard } from './tokenUsage/tokenUsageDashboard';
import { VendorDashboard } from './tokenUsage/vendorDashboard';
import { ModelDashboard } from './tokenUsage/modelDashboard';
import { SessionDashboard } from './tokenUsage/sessionDashboard';
import { setUsdToCnyRate, combineToCny } from './tokenUsage/tokenCostEstimator';
import { LogServiceImpl, LogLevel } from './platform/log/common/logService';
import { VSCodeLogTarget, ConsoleLogTarget } from './platform/log/vscode/logService';
import { logVendorMapping } from './tokenUsage/vendorResolver';
import { LEGACY_CONFIG_MAP, LEGACY_CONFIG_MIGRATION_VERSION, STATE_KEYS, planConfigMigration, planSeenRequestIdsMigration, ConfigInspectLike } from './tokenUsage/legacyConfig';
import { AccountCredentialStore } from './accountUsage/credentialStore';
import { AccountUsageService } from './accountUsage/accountUsageService';
import { PROVIDER_FETCHERS } from './accountUsage/fetchers';
import { resolveCurrentProvider, providerVendorMatches } from './accountUsage/currentProvider';
import { registerAccountCommands } from './accountUsage/accountCommands';
import type { AccountProviderId } from './accountUsage/types';

export function activate(context: vscode.ExtensionContext) {
	const activationStart = Date.now();

	// ─── Logging ───────────────────────────────────────────────────────
	const logChannel = vscode.window.createOutputChannel('ModelMeter', { log: true });
	context.subscriptions.push(logChannel);
	// Log level: "normal" keeps only summaries + warnings/errors in the output
	// channel; "debug" additionally surfaces per-root/per-file/import details.
	// Compat reads: the new `modelMeter.*` keys win; legacy `copilotAlternatives.*`
	// values are honored until the one-shot namespace migration (below) has run.
	const initialLogLevel = readConfigCompat<string>('modelMeter.logLevel', 'copilotAlternatives.logLevel', 'normal');
	const vscodeLogTarget = new VSCodeLogTarget(logChannel, initialLogLevel === 'debug' ? LogLevel.Debug : LogLevel.Info);
	const logService = new LogServiceImpl([
		vscodeLogTarget,
		new ConsoleLogTarget('[CA] ', LogLevel.Warning),
	]);

	logService.info('ModelMeter extension activating...');
	// NOTE: the output channel is intentionally NOT auto-shown on activation.
	// Run “Token 用量诊断” (or pick ModelMeter in the Output view) to inspect logs.

	// One-shot legacy namespace migration (config keys + seenRequestIds state).
	// Runs asynchronously; reads above and below use compat fallbacks so the
	// first session behaves correctly even before the writes land.
	void migrateLegacyNamespace(context, logService);

	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration('modelMeter.logLevel')) { return; }
			const level = readConfigCompat<string>('modelMeter.logLevel', 'copilotAlternatives.logLevel', 'normal');
			vscodeLogTarget.setMinLevel(level === 'debug' ? LogLevel.Debug : LogLevel.Info);
			logService.info(`Log level changed to: ${level === 'debug' ? 'debug' : 'normal'}`);
		})
	);

	// Load the USD→CNY display rate from settings (no network lookup)
	setUsdToCnyRate(readConfigCompat<number>('modelMeter.tokenUsage.usdToCnyRate', 'copilotAlternatives.tokenUsage.usdToCnyRate', 7.2));

	// ─── Token Usage Tracking ───────────────────────────────────────────
	const tokenTracker = new TokenUsageTracker(context.globalState, context.globalStorageUri.fsPath, logService.createSubLogger('TokenUsage'));
	tokenTracker.activate(context);
	context.subscriptions.push(tokenTracker);

	// ─── 0.3.0 账户与套餐（官方额度） ───
	// All account state lives in one service; credentials ONLY in
	// SecretStorage. Nothing here touches the network during activation —
	// first fetches are scheduled off the critical path below.
	const accountCredentials = new AccountCredentialStore(context.secrets);
	const currentAccountContext: { providerId: AccountProviderId | null; modelId: string | null } = { providerId: null, modelId: null };
	let currentContextResolvedAt = 0;
	const refreshCurrentContext = async (force = false): Promise<void> => {
		if (!force && Date.now() - currentContextResolvedAt < 20_000) { return; }
		currentContextResolvedAt = Date.now();
		try {
			const ids = await tokenTracker.metricsService.getRecentModelIds(30);
			currentAccountContext.modelId = ids[0] ?? null;
			currentAccountContext.providerId = resolveCurrentProvider(ids);
		} catch { /* keep previous context */ }
	};
	const accountService = new AccountUsageService({
		credentials: accountCredentials,
		memento: context.globalState,
		fetchers: PROVIDER_FETCHERS,
		resolveCurrentProvider: () => currentAccountContext.providerId,
		log: message => logService.info(`[Account] ${message}`),
	});
	void accountService.refreshConnectedFlags();

	const localTotalsFor = async (provider: AccountProviderId): Promise<{ tokens: number; costCny: number }> => {
		const vendors = await tokenTracker.metricsService.getVendorBreakdown7d();
		const rows = vendors.filter(v => providerVendorMatches(provider, v.vendor));
		return {
			tokens: rows.reduce((s, v) => s + v.totalTokens, 0),
			costCny: rows.reduce((s, v) => s + combineToCny(v.costUsd, v.costCny), 0),
		};
	};

	// ─── Sidebar（ModelMeter WebviewView） ───────────────────────────────
	// The previous tree sidebar is replaced by a webview view. TreeProvider is
	// kept only as the session-filter state holder used by the filter commands.
	const treeProvider = new TreeProvider(context.extensionPath, tokenTracker);
	const sidebarProvider = new ModelMeterSidebarProvider(
		tokenTracker,
		(context.extension.packageJSON as { version?: string }).version ?? '',
		() => treeProvider.sessionFilter,
		accountService,
	);
	context.subscriptions.push(sidebarProvider);
	context.subscriptions.push(vscode.window.registerWebviewViewProvider('modelMeter.main', sidebarProvider, {
		webviewOptions: { retainContextWhenHidden: false },
	}));

	const tokenStatusBar = new TokenUsageStatusBar(
		tokenTracker,
		accountService,
		() => currentAccountContext,
		localTotalsFor,
	);
	tokenTracker.onDidUpdate(() => tokenStatusBar.update());
	// Refresh dashboard when stored data changes (if dashboard is open)
	tokenTracker.onDidChangeStored(() => {
		tokenStatusBar.update();
		if (TokenUsageDashboard.currentPanel) {
			TokenUsageDashboard.currentPanel.update();
		}
		if (VendorDashboard.currentPanel) {
			VendorDashboard.currentPanel.update();
		}
		if (ModelDashboard.currentPanel) {
			ModelDashboard.currentPanel.update();
		}
		if (SessionDashboard.currentPanel) {
			SessionDashboard.currentPanel.update();
		}
		sidebarProvider.notifyDataChanged();
		// 0.3.0: re-resolve the current model (cheap, cached) and refresh only
		// the current provider's account (TTL/single-flight guarded inside).
		void refreshCurrentContext().then(async () => {
			tokenStatusBar.update();
			await accountService.ensureFresh(accountService.currentProvider());
		});
	});
	context.subscriptions.push(tokenStatusBar);

	// Account-state changes repaint both surfaces (no fetch is triggered here).
	context.subscriptions.push(accountService.onDidChange(() => {
		tokenStatusBar.update();
		sidebarProvider.notifyDataChanged();
	}));
	// Credentials added/removed outside our flows (or cleared from settings sync).
	context.subscriptions.push(context.secrets.onDidChange(() => {
		void accountService.refreshConnectedFlags().then(() => sidebarProvider.notifyDataChanged());
	}));

	// Account commands (connect / reconnect / disconnect / show section).
	registerAccountCommands(context, {
		service: accountService,
		credentials: accountCredentials,
		focusAccountSection: provider => { void sidebarProvider.focusAccount(provider); },
		notifyViews: () => { tokenStatusBar.update(); sidebarProvider.notifyDataChanged(); },
	});

	// Off the critical path: resolve which provider the recent turns belong to,
	// then ask for a TTL-guarded refresh of just that account.
	setTimeout(() => {
		void refreshCurrentContext(true).then(async () => {
			tokenStatusBar.update();
			await accountService.ensureFresh(accountService.currentProvider());
		});
	}, 900);

	// ─── Token Usage Commands ───────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.showTokenUsage', () => {
			const dashboard = TokenUsageDashboard.createOrShow(tokenTracker);
			dashboard.update();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.reloadTokenUsage', async () => {
			const answer = await vscode.window.showWarningMessage(
				'要从本地会话文件重新构建统计数据吗？将重新读取所有 Copilot 会话事件日志并更新数据库。',
				{ modal: true },
				'重新构建'
			);
			if (answer !== '重新构建') { return; }
			await tokenTracker.reloadAll();
			vscode.window.showInformationMessage('统计数据已从本地会话文件重新构建。');
			if (TokenUsageDashboard.currentPanel) {
				TokenUsageDashboard.currentPanel.update();
			}
			if (VendorDashboard.currentPanel) {
				VendorDashboard.currentPanel.update();
			}
			if (ModelDashboard.currentPanel) {
				ModelDashboard.currentPanel.update();
			}
			if (SessionDashboard.currentPanel) {
				SessionDashboard.currentPanel.update();
			}
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.exportTokenUsage', async () => {
			const s = await tokenTracker.metricsService.getDashboardSummary();
			const json = JSON.stringify(s, null, 2);
			vscode.workspace.openTextDocument({ content: json, language: 'json' })
				.then(doc => vscode.window.showTextDocument(doc));
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.debugTokenUsage', async () => {
			const s = await tokenTracker.metricsService.getDashboardSummary();
			const log = logService.createSubLogger('Debug');

			for (const v of s.vendorBreakdown) {
				log.info(`  ${v.vendor}: in=${v.promptTokens} out=${v.completionTokens} cost=¥${combineToCny(v.costUsd, v.costCny).toFixed(4)} ${v.requestCount} requests`);
			}

			// Model breakdown
			log.info('--- Model Breakdown (30 days) ---');
			for (const m of s.modelBreakdown) {
				log.info(`  ${m.modelId}: in=${m.promptTokens} out=${m.completionTokens} cost=¥${combineToCny(m.costUsd, m.costCny).toFixed(4)} ${m.requestCount} requests`);
			}

			// All-time totals
			log.info('--- All Time ---');
			log.info(`  Days tracked: ${s.allTime.daysTracked}`);
			log.info(`  Total tokens: ${s.allTime.totalPromptTokens + s.allTime.totalCompletionTokens} (in: ${s.allTime.totalPromptTokens}, out: ${s.allTime.totalCompletionTokens})`);
			log.info(`  Total cost: ¥${combineToCny(s.allTime.totalCostUsd, s.allTime.totalCostCny).toFixed(4)}`);
			log.info(`  Sessions: ${s.allTime.sessionCount}, Requests: ${s.allTime.requestCount}`);

			logVendorMapping(s.modelBreakdown.map(m => m.modelId), log);

			log.info('--- Storage & Import Diagnostics ---');
			for (const line of await tokenTracker.metricsService.getDiagnostics()) {
				log.info(line);
			}

			log.info('=== End Debug Info ===');
			logService.show();
			vscode.window.showInformationMessage('Token 用量诊断信息已写入输出面板。');
		})
	);

	// ─── Vendor & Model Usage Commands ──────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.showVendorUsage', async (arg?: string | TreeNode) => {
			let vendor: string | undefined;
			if (typeof arg === 'string') {
				vendor = arg;
			} else if (arg && typeof arg === 'object' && 'id' in arg) {
				vendor = arg.id.replace(/^usage-vendor:/, '');
			}
			// Fallback: pick first vendor with usage data
			if (!vendor) {
				const vendors = await tokenTracker.metricsService.getAllVendors();
				vendor = vendors[0];
			}
			if (!vendor) {
				vscode.window.showInformationMessage('暂无厂商用量数据。');
				return;
			}
			const dashboard = VendorDashboard.createOrShow(tokenTracker, vendor);
			dashboard.update();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.showModelUsage', (arg?: string) => {
			const dashboard = ModelDashboard.createOrShow(tokenTracker);
			dashboard.update();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.showModelUsageForVendor', (arg: string | TreeNode) => {
			let vendor: string | undefined;
			if (typeof arg === 'string') {
				vendor = arg;
			} else if (arg && typeof arg === 'object' && 'id' in arg) {
				vendor = arg.id.replace(/^usage-vendor:/, '');
			}
			const dashboard = ModelDashboard.createOrShow(tokenTracker, vendor);
			dashboard.update();
		})
	);

	// ─── Tree inline chart button commands ──────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.openUsageOverview', (node?: TreeNode) => {
			const dashboard = TokenUsageDashboard.createOrShow(tokenTracker);
			dashboard.update();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.openUsageVendor', (node?: TreeNode) => {
			if (!node || !node.id) { return; }
			const vendor = node.id.replace(/^usage-vendor:/, '');
			const dashboard = VendorDashboard.createOrShow(tokenTracker, vendor);
			dashboard.update();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.openUsageModel', (node?: TreeNode) => {
			if (!node || !node.id) { return; }
			const modelId = node.id.replace(/^usage-model:/, '');
			const vendor = modelId.includes('/') ? modelId.split('/')[0] : undefined;
			const dashboard = ModelDashboard.createOrShow(tokenTracker, vendor, modelId);
			dashboard.update();
		})
	);

	// ─── Session Stats Commands ─────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.showSessionDetail', (sessionId: string) => {
			const dashboard = SessionDashboard.createOrShow(tokenTracker, sessionId);
			dashboard.update();
		})
	);

	// Open session filter wizard.
	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.toggleSessionFilter', async () => {
			const current = treeProvider.sessionFilter;
			const opts = await tokenTracker.metricsService.getSessionFilterOptions();
			const filter: { days: number; modelName?: string } = { days: current.days };

			// Step 1: Date range
			const datePick = await vscode.window.showQuickPick(
				[
					{ label: '最近 7 天', days: 7 },
					{ label: '最近 30 天', days: 30 },
					{ label: '最近 90 天', days: 90 },
					{ label: '全部时间', days: 3650 },
				],
				{ placeHolder: '选择筛选的日期范围…', title: '会话筛选 — 日期范围' },
			);
			if (!datePick) { return; }
			filter.days = datePick.days;

			// Step 2: Model
			if (opts.modelNames.length > 0) {
				const pick = await vscode.window.showQuickPick(
					[{ label: '全部模型', val: '' }, ...opts.modelNames.map(m => ({ label: m, val: m }))],
					{ placeHolder: '按模型筛选（Esc 跳过）…', title: '会话筛选 — 模型' },
				);
				if (!pick) { return; }
				filter.modelName = pick.val || undefined;
			}

			treeProvider.sessionFilter = filter;
			sidebarProvider.notifyDataChanged();
		})
	);

	// Clear session filter — show all sessions (3650 days, no model filter).
	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.clearSessionFilter', () => {
			treeProvider.sessionFilter = { days: 3650 };
			treeProvider.refresh();
			sidebarProvider.notifyDataChanged();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.copySessionId', (sessionId: string) => {
			vscode.env.clipboard.writeText(sessionId);
			vscode.window.showInformationMessage(`已复制会话 ID：${sessionId}`);
		})
	);

	// Listen for currency-rate changes to refresh the status bar and open dashboards
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration('modelMeter.tokenUsage.usdToCnyRate')) { return; }
			setUsdToCnyRate(readConfigCompat<number>('modelMeter.tokenUsage.usdToCnyRate', 'copilotAlternatives.tokenUsage.usdToCnyRate', 7.2));
			tokenStatusBar.update();
			if (TokenUsageDashboard.currentPanel) { TokenUsageDashboard.currentPanel.update(); }
			if (VendorDashboard.currentPanel) { VendorDashboard.currentPanel.update(); }
			if (ModelDashboard.currentPanel) { ModelDashboard.currentPanel.update(); }
			if (SessionDashboard.currentPanel) { SessionDashboard.currentPanel.update(); }
		})
	);

	// ─── Commands ───────────────────────────────────────────────────────
	setExtensionPath(context.extensionPath);
	setTreeRefresher(() => treeProvider.refresh());
	registerNodeActions(context);

	// Command to open/focus the sidebar view
	context.subscriptions.push(
		vscode.commands.registerCommand('modelMeter.openSidebar', () => {
			vscode.commands.executeCommand('workbench.view.extension.modelMeter');
		})
	);

	// activate() itself is fully synchronous — token usage imports (quickImport/
	// backgroundImport) run afterward via setImmediate/promise chains and log
	// their own elapsed time separately.
	logService.info(`ModelMeter extension activated in ${Date.now() - activationStart}ms (synchronous setup only; background sync deferred ~700ms)`);
}

// ─── Legacy namespace migration & compat reads ──────────────────────────

/**
 * Reads a config value while honoring the legacy key as a fallback: the new
 * key wins whenever the user (or the migration) has set it explicitly.
 */
function readConfigCompat<T>(newKey: string, legacyKey: string, fallback: T): T {
	const cfg = vscode.workspace.getConfiguration();
	if (hasExplicitValue(cfg.inspect(newKey))) { return cfg.get<T>(newKey, fallback); }
	if (hasExplicitValue(cfg.inspect(legacyKey))) { return cfg.get<T>(legacyKey, fallback); }
	return fallback;
}

function hasExplicitValue(insp: { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined): boolean {
	if (!insp) { return false; }
	return insp.globalValue !== undefined || insp.workspaceValue !== undefined || insp.workspaceFolderValue !== undefined;
}

function toInspectLike(insp: { globalValue?: unknown; workspaceValue?: unknown; workspaceFolderValue?: unknown } | undefined): ConfigInspectLike {
	return insp ?? {};
}

/**
 * One-shot migration: copies explicitly-set legacy `copilotAlternatives.*`
 * settings to `modelMeter.*` (never overwriting an explicit new value) and
 * renames the notification-dedup globalState key `csw.seenRequestIds`.
 * Recorded in globalState (`modelMeter.migrations.legacyConfigVersion`).
 */
async function migrateLegacyNamespace(context: vscode.ExtensionContext, logService: LogServiceImpl): Promise<void> {
	try {
		const doneVersion = context.globalState.get<number>(STATE_KEYS.configMigrationVersion, 0);
		const cfg = vscode.workspace.getConfiguration();

		if (doneVersion < LEGACY_CONFIG_MIGRATION_VERSION) {
			for (const { legacy, current } of LEGACY_CONFIG_MAP) {
				const plan = planConfigMigration(toInspectLike(cfg.inspect(current)), toInspectLike(cfg.inspect(legacy)));
				if (!plan.migrate) { continue; }
				const value = cfg.get(legacy);
				if (value === undefined) { continue; }
				try {
					await cfg.update(current, value, plan.target === 'global'
						? vscode.ConfigurationTarget.Global
						: vscode.ConfigurationTarget.Workspace);
					logService.info(`[Migration] moved setting ${legacy} → ${current}`);
				} catch (err) {
					logService.warn(`[Migration] failed to move ${legacy} → ${current}: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		} else {
			// Version already recorded — still ensure the state key rename is done.
		}

		// Rename the notification-dedup state key (new key wins; legacy is purged).
		const seenNew = context.globalState.get<string[]>(STATE_KEYS.seenRequestIds);
		const seenLegacy = context.globalState.get<string[]>(STATE_KEYS.seenRequestIdsLegacy);
		const planned = planSeenRequestIdsMigration(seenNew, seenLegacy);
		if (seenNew === undefined && planned !== undefined) {
			await context.globalState.update(STATE_KEYS.seenRequestIds, planned);
			logService.info(`[Migration] moved state ${STATE_KEYS.seenRequestIdsLegacy} → ${STATE_KEYS.seenRequestIds} (${planned.length} entries)`);
		}
		if (seenLegacy !== undefined) {
			await context.globalState.update(STATE_KEYS.seenRequestIdsLegacy, undefined);
		}

		await context.globalState.update(STATE_KEYS.configMigrationVersion, LEGACY_CONFIG_MIGRATION_VERSION);
	} catch (err) {
		logService.warn(`[Migration] legacy namespace migration failed: ${err instanceof Error ? err.message : String(err)}`);
	}
}

// ─── Legacy webview (kept as fallback) ──────────────────────────────────────

function openDirectory(context: vscode.ExtensionContext) {
	const panel = vscode.window.createWebviewPanel(
		'modelMeter.directory',
		'目录',
		vscode.ViewColumn.One,
		{ enableScripts: false, retainContextWhenHidden: true }
	);

	const readmePath = path.join(context.extensionPath, 'README.md');
	let readme = '';
	try {
		readme = fs.readFileSync(readmePath, 'utf-8');
	} catch {
		readme = '未找到 README.md。';
	}

	const rows = parseTableSections(readme);

	panel.webview.html = getHtml(rows, readme);
}

interface TableSection {
	title: string;
	tableHtml: string;
}

function parseTableSections(md: string): TableSection[] {
	const sections: TableSection[] = [];
	const parts = md.split(/(?=^### )/gm);

	for (const part of parts) {
		const headingMatch = part.match(/^### (.+)/);
		if (!headingMatch) continue;

		const tableMatch = part.match(/(\|.+\|[\r\n]+\|[-| :]+\|[\r\n]+(?:\|.+\|[\r\n]*)+)/);
		if (!tableMatch) continue;

		const title = headingMatch[1].trim();
		const tableMd = tableMatch[1].trim();
		const tableHtml = markdownTableToHtml(tableMd);
		if (tableHtml) {
			sections.push({ title, tableHtml });
		}
	}
	return sections;
}

function markdownTableToHtml(tableMd: string): string {
	const lines = tableMd.split(/\r?\n/).filter(l => l.trim());
	if (lines.length < 2) return '';

	const headers = parseRow(lines[0]);
	const rows = lines.slice(2).map(parseRow);

	let html = '<table><thead><tr>';
	for (const h of headers) {
		html += '<th>' + renderInlineMd(h) + '</th>';
	}
	html += '</tr></thead><tbody>';
	for (const row of rows) {
		html += '<tr>';
		for (const cell of row) {
			html += '<td>' + renderInlineMd(cell) + '</td>';
		}
		html += '</tr>';
	}
	html += '</tbody></table>';
	return html;
}

function parseRow(line: string): string[] {
	return line.split('|').slice(1, -1).map(c => c.trim());
}

function renderInlineMd(text: string): string {
	let out = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1<\/a>');
	out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
	out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
	out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
	return out;
}

function getHtml(sections: TableSection[], rawReadme: string): string {
	const introMatch = rawReadme.match(/^# .+([\s\S]+?)(?=^## )/m);
	const intro = introMatch ? renderInlineMd(introMatch[1].trim().split('\n').filter(l => !l.startsWith('The focus') && !l.startsWith('- AI-powered')).join('\n')) : '';

	const choosingMatch = rawReadme.match(/### (?:Choosing a Coding Plan|选择编程方案|如何选择编程方案)([\s\S]+?)(?=^---|\n## )/m);
	const choosing = choosingMatch ? renderInlineMd(choosingMatch[1].trim()) : '';

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>目录</title>
<style>
:root {
	--bg: var(--vscode-editor-background, #1e1e2e);
	--fg: var(--vscode-editor-foreground, #e2e8f0);
	--dim: var(--vscode-descriptionForeground, #94a3b8);
	--accent: var(--vscode-textLink-foreground, #7c3aed);
	--accent-bg: var(--vscode-textLink-activeForeground, #a78bfa);
	--border: var(--vscode-widget-border, #334155);
	--card: var(--vscode-editorWidget-background, #282840);
	--card-hover: var(--vscode-list-hoverBackground, #32325a);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
	font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
	background: var(--bg);
	color: var(--fg);
	padding: 20px 28px;
	font-size: 13px;
	line-height: 1.5;
}
h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; color: var(--vscode-textLink-foreground); }
.subtitle { color: var(--vscode-descriptionForeground); font-size: 14px; margin-bottom: 24px; }
h2 { font-size: 18px; font-weight: 600; margin: 28px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--vscode-widget-border); }
table { width: 100%; border-collapse: collapse; margin: 8px 0 20px; font-size: 12.5px; }
th { text-align: left; padding: 8px 10px; background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); font-weight: 600; white-space: nowrap; }
td { padding: 7px 10px; border: 1px solid var(--vscode-widget-border); vertical-align: top; }
tr:hover td { background: var(--vscode-list-hoverBackground); }
a { color: var(--vscode-textLink-foreground); text-decoration: none; }
a:hover { text-decoration: underline; }
code { background: var(--vscode-editorWidget-background); padding: 1px 4px; border-radius: 3px; font-size: 12px; }
.toc { background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border); border-radius: 8px; padding: 16px 20px; margin-bottom: 24px; }
.toc h2 { margin-top: 0; border: none; padding: 0; }
.toc ul { list-style: none; padding: 0; columns: 2; }
.toc li { padding: 2px 0; }
@media (max-width: 700px) { .toc ul { columns: 1; } }
.note { background: var(--vscode-editorWidget-background); border-left: 3px solid var(--vscode-textLink-foreground); padding: 10px 14px; margin: 10px 0; border-radius: 0 6px 6px 0; font-size: 12.5px; }
</style>
</head>
<body>
<h1>🧩 ModelMeter — GitHub Copilot 替代方案目录</h1>
<p class="subtitle">精选的 GitHub Copilot 替代方案目录。</p>

<div class="toc"><h2>目录</h2><ul>
${sections.map((s, i) => `<li><a href="#sec-${i}">${s.title}</a></li>`).join('\n')}
</ul></div>

${sections.map((s, i) => `<h2 id="sec-${i}">${s.title}</h2>${s.tableHtml}`).join('\n')}

${choosing ? '<h2 id="choosing">如何选择编程方案</h2><div class="note">' + choosing.split('\n').filter(l => l.trim()).join('<br>') + '</div>' : ''}
</body>
</html>`;
}

export function deactivate() {}
