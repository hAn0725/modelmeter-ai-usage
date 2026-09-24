/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModelMeter sidebar — a WebviewView implementation of the activity-bar view
 * (`modelMeter.main`).
 *
 * Design goals:
 *  - Clearly distinct from the original copilot-alternatives tree sidebar:
 *    brand header, weekly hero stats, proportional vendor usage bars, compact
 *    recent-session list, action buttons.
 *  - View-only: all data comes from `MetricsService`; all navigation reuses the
 *    existing `modelMeter.*` commands. No business logic is duplicated.
 *  - Security: strict CSP with a per-load nonce, no remote resources, no eval,
 *    and an explicit message-type whitelist (never executeCommand(message.…)).
 *  - Performance: the HTML is built once per view load; data updates are sent
 *    via postMessage with a debounce, so token events don't rebuild the page.
 */

import * as vscode from 'vscode';
import type { TokenUsageTracker } from './tokenUsageTracker';
import { formatTokenCount, formatCnyCompact, combineToCny } from './tokenCostEstimator';
import { formatVendorName } from './vendorDisplay';
import type { AccountUsageService } from '../accountUsage/accountUsageService';
import type { AccountProviderId } from '../accountUsage/types';
import { ACCOUNT_PROVIDERS } from '../accountUsage/providerRegistry';
import { providerVendorMatches } from '../accountUsage/currentProvider';
import { buildAccountDetail, buildAccountRow, type AccountDetailModel, type AccountRowModel, type LocalProviderTotals } from '../accountUsage/accountViewModel';

// ─── View model sent to the webview ────────────────────────────────────────

export interface SidebarVendorRow {
	/** Raw vendor id from the database (used for navigation; display name is separate). */
	id: string;
	name: string;
	meta: string;
	pct: number;
	color: number;
}

export interface SidebarSessionRow {
	id: string;
	title: string;
	meta: string;
	right: string;
}

export interface SidebarData {
	version: string;
	generated: string;
	week: {
		tokens: string;
		requests: string;
		cost: string;
		costNote: string;
	};
	vendors: SidebarVendorRow[];
	sessions: SidebarSessionRow[];
	sessionsHint: string;
	empty: boolean;
	/** 0.3.0 账户与套餐 section. */
	accounts: AccountRowModel[];
	accountDetail: AccountDetailModel | null;
	accountExpanded: string | null;
}

const VENDOR_BAR_COLORS = 5;

function pad2(n: number): string {
	return n < 10 ? '0' + n : String(n);
}

function formatSessionStamp(ts: number): string {
	const d = new Date(ts);
	return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Whitelist-checked provider id from a webview message. */
function readProviderArg(msg: unknown): AccountProviderId | undefined {
	const value = (msg as { provider?: unknown }).provider;
	return typeof value === 'string' && /^[a-z]{2,16}$/.test(value) && ACCOUNT_PROVIDERS.some(p => p.id === value)
		? value as AccountProviderId
		: undefined;
}

// ─── Provider ──────────────────────────────────────────────────────────────

/** Session list filter state shared with the toggleSessionFilter / clearSessionFilter commands. */
export interface ModelMeterSessionFilter {
	days: number;
	modelName?: string;
}

export class ModelMeterSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private _view: vscode.WebviewView | undefined;
	private _debounce: ReturnType<typeof setTimeout> | undefined;
	/** Single account row expanded at a time (provider id or null). */
	private _expandedAccount: string | null = null;

	constructor(
		private readonly _tracker: TokenUsageTracker,
		private readonly _extensionVersion: string,
		private readonly _getSessionFilter: () => ModelMeterSessionFilter,
		private readonly _accounts: AccountUsageService,
	) { }

	/** Called by `modelMeter.showAccountSection` / status bar: expand one account. */
	async focusAccount(providerId: AccountProviderId | null): Promise<void> {
		this._expandedAccount = providerId;
		if (!this._view) {
			// First interaction may happen before the view ever resolved — asking
		// VS Code to focus the view id makes it create/reveal the sidebar.
			try { await vscode.commands.executeCommand('modelMeter.main.focus'); } catch { /* ignore */ }
		}
		if (this._view && !this._view.visible) {
			try { this._view.show?.(true); } catch { /* older VS Code without WebviewView.show */ }
		}
		await this._pushData();
		if (this._view) {
			await this._view.webview.postMessage({ type: 'focusAccount', payload: providerId });
		}
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this._view = view;
		// CSP-first (see webviewCsp.ts): set the html carrying the CSP meta
		// before enabling scripts, otherwise VS Code logs a missing-CSP warning.
		view.webview.html = this._buildHtml(view.webview);
		view.webview.options = { enableScripts: true };

		view.webview.onDidReceiveMessage(msg => this._onMessage(msg));
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				void this._pushData();
			}
		});

		void this._pushData();
	}

	/** Debounced data refresh — safe to call on every stored-data change. */
	notifyDataChanged(): void {
		if (this._debounce !== undefined) {
			clearTimeout(this._debounce);
		}
		this._debounce = setTimeout(() => {
			this._debounce = undefined;
			void this._pushData();
		}, 300);
	}

	dispose(): void {
		if (this._debounce !== undefined) {
			clearTimeout(this._debounce);
			this._debounce = undefined;
		}
	}

	// ── Data collection (MetricsService only — no business logic) ──────

	private async _collectData(): Promise<SidebarData> {
		const ms = this._tracker.metricsService;
		const filter = this._getSessionFilter();

		const [vendors, sessions] = await Promise.all([
			ms.getVendorBreakdown7d(),
			ms.listSessions(filter.days, { modelName: filter.modelName }),
		]);

		const totalTokens = vendors.reduce((s, v) => s + v.totalTokens, 0);
		const totalRequests = vendors.reduce((s, v) => s + v.requestCount, 0);
		const totalCost = vendors.reduce((s, v) => s + combineToCny(v.costUsd, v.costCny), 0);
		const totalUnpriced = vendors.reduce((s, v) => s + v.unpricedCount, 0);

		const maxTokens = Math.max(1, ...vendors.map(v => v.totalTokens));
		const vendorRows: SidebarVendorRow[] = vendors
			.filter(v => v.totalTokens > 0)
			.sort((a, b) => b.totalTokens - a.totalTokens || b.requestCount - a.requestCount)
			.map((v, i) => ({
				id: v.vendor,
				name: formatVendorName(v.vendor),
				meta: `${formatTokenCount(v.totalTokens)} · ${v.requestCount} 次`,
				pct: Math.max(2, Math.round((v.totalTokens / maxTokens) * 100)),
				color: i % VENDOR_BAR_COLORS,
			}));

		const sessionRows: SidebarSessionRow[] = [...sessions]
			.sort((a, b) => b.creation_date - a.creation_date)
			.map(s => {
				const cost = combineToCny(s.costUsd, s.costCny);
				const title = s.session_model_name
					|| formatVendorName(s.session_vendor);
				return {
					id: s.session_id,
					title,
					meta: `${s.turnCount} 轮 · ${formatSessionStamp(s.creation_date)}`,
					right: cost > 0 ? formatCnyCompact(cost) : '',
				};
			});

		const now = new Date();
		const parseIncomplete = totalRequests > 0 && totalUnpriced >= totalRequests;
		const rangeLabel = filter.days >= 3650 ? '全部时间' : `近 ${filter.days} 天`;
		const sessionsHint = filter.modelName ? `${rangeLabel} · ${filter.modelName}` : rangeLabel;

		// ── 0.3.0 accounts view model ─────────────────────────────────
		const nowMs = now.getTime();
		const accountStates = this._accounts.getAll();
		const currentProvider = this._accounts.currentProvider();
		const accountRows: AccountRowModel[] = [];
		for (const def of ACCOUNT_PROVIDERS) {
			const state = accountStates.find(s => s.provider === def.id);
			if (!state) { continue; }
			accountRows.push(buildAccountRow(def, state, def.id === currentProvider));
		}
		const expandedState = this._expandedAccount
			? accountStates.find(s => s.provider === this._expandedAccount) ?? null
			: null;
		let accountDetail: AccountDetailModel | null = null;
		if (expandedState && expandedState.connected) {
			const localRows = vendors.filter(v => providerVendorMatches(expandedState.provider, v.vendor));
			const localTotals: LocalProviderTotals | null = localRows.length > 0
				? {
					tokens: localRows.reduce((s, v) => s + v.totalTokens, 0),
					costCny: localRows.reduce((s, v) => s + combineToCny(v.costUsd, v.costCny), 0),
				}
				: null;
			accountDetail = buildAccountDetail(expandedState.provider, expandedState, localTotals, nowMs);
		}
		const accountExpanded = expandedState ? this._expandedAccount : null;

		return {
			version: this._extensionVersion,
			generated: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
			week: {
				tokens: formatTokenCount(totalTokens),
				requests: String(totalRequests),
				cost: parseIncomplete && totalCost === 0 ? '—' : formatCnyCompact(totalCost),
				costNote: '按官方按量价',
			},
			vendors: vendorRows,
			sessions: sessionRows,
			sessionsHint,
			empty: vendorRows.length === 0 && sessionRows.length === 0,
			accounts: accountRows,
			accountDetail,
			accountExpanded,
		};
	}

	private async _pushData(): Promise<void> {
		if (!this._view) { return; }
		try {
			const data = await this._collectData();
			await this._view.webview.postMessage({ type: 'data', payload: data });
		} catch {
			// Never let a data hiccup take down the sidebar.
		}
	}

	// ── Message whitelist (webview → host) ─────────────────────────────

	private _onMessage(msg: unknown): void {
		if (!msg || typeof msg !== 'object') { return; }
		const type = (msg as { type?: unknown }).type;		const providerArg = readProviderArg(msg);		switch (type) {
			case 'ready':
				void this._pushData();
				break;
			case 'openOverview':
				void vscode.commands.executeCommand('modelMeter.showTokenUsage');
				break;
			case 'openVendor': {
				const vendorId = (msg as { vendorId?: unknown }).vendorId;
				const safeVendor = typeof vendorId === 'string' && vendorId.length > 0 && vendorId.length < 64 && !/[<>"'&]/.test(vendorId)
					? vendorId
					: undefined;
				void vscode.commands.executeCommand('modelMeter.showVendorUsage', safeVendor);
				break;
			}
			case 'openModel':
				void vscode.commands.executeCommand('modelMeter.showModelUsage');
				break;
			case 'openSession': {
				const id = (msg as { sessionId?: unknown }).sessionId;
				if (typeof id === 'string' && id.length > 0 && id.length < 128) {
					void vscode.commands.executeCommand('modelMeter.showSessionDetail', id);
				}
				break;
			}
			case 'refresh':
				void vscode.commands.executeCommand('modelMeter.reloadTokenUsage');
				break;
			case 'toggleAccount':
				if (providerArg) {
					this._expandedAccount = this._expandedAccount === providerArg ? null : providerArg;
					void this._pushData();
				}
				break;
			case 'refreshAccount':
				if (providerArg) {
					void this._accounts.ensureFresh(providerArg, { manual: true }).then(() => this._pushData());
				}
				break;
			case 'connectAccount':
			case 'manageAccounts':
				void vscode.commands.executeCommand('modelMeter.manageAccounts', providerArg);
				break;
			case 'openHelp':
				void vscode.commands.executeCommand('modelMeter.openHelpDoc');
				break;
			default:
				// Unknown message types are ignored on purpose.
				break;
		}
	}

	// ── HTML (built once per view load; data arrives via postMessage) ──

	private _buildHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const csp = [
			`default-src 'none'`,
			`img-src data:`,
			`style-src 'nonce-${nonce}'`,
			`script-src 'nonce-${nonce}'`,
			`font-src 'none'`,
		].join('; ');

		return /* html */`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
	:root {
		--mm-radius: 6px;
		--mm-track: rgba(127, 127, 127, 0.22);
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 10px 12px 14px;
		background: var(--vscode-sideBar-background, var(--vscode-editor-background));
		color: var(--vscode-foreground);
		font-family: var(--vscode-font-family);
		font-size: 12px;
		line-height: 1.45;
		overflow-x: hidden;
	}
	.hdr {
		display: flex; align-items: baseline; justify-content: space-between;
		gap: 8px; margin-bottom: 8px;
	}
	.brand { font-size: 13px; font-weight: 600; letter-spacing: 0.2px; }
	.brand .ver { font-size: 10px; font-weight: 400; color: var(--vscode-descriptionForeground); margin-left: 4px; }
	.updated { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }

	.hero {
		border: 1px solid var(--vscode-contrastBorder, transparent);
		background: var(--vscode-input-background, transparent);
		border-radius: var(--mm-radius);
		padding: 8px 10px 7px;
		display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 8px;
	}
	.hero .cell { min-width: 0; }
	.hero .v {
		font-size: 15px; font-weight: 600; white-space: nowrap;
		overflow: hidden; text-overflow: ellipsis;
	}
	.hero .v.small { font-size: 13px; }
	.hero .l { font-size: 10px; color: var(--vscode-descriptionForeground); }
	.hero .l.sub { font-size: 9px; opacity: .85; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

	.sec-h {
		display: flex; align-items: center; justify-content: space-between;
		margin: 12px 0 4px;
		font-size: 11px; font-weight: 600;
		color: var(--vscode-foreground);
	}
	.sec-h .hint { font-size: 10px; font-weight: 400; color: var(--vscode-descriptionForeground); }
	.divider { border: 0; border-top: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent)); margin: 10px 0 0; opacity: 0.7; }

	.vrow { padding: 5px 0 3px; cursor: pointer; border-radius: 4px; }
	.vrow:hover, .vrow:focus-visible { background: var(--vscode-list-hoverBackground); }
	.vrow:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
	.vrow .top { display: flex; justify-content: space-between; gap: 8px; }
	.vrow .name { flex: 1 1 auto; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.vrow .meta { flex: 0 0 auto; color: var(--vscode-descriptionForeground); white-space: nowrap; font-size: 11px; }
	.track { height: 5px; border-radius: 3px; background: var(--mm-track); margin-top: 2px; overflow: hidden; }
	.fill { height: 100%; border-radius: 3px; }
	.fill.c0 { background: var(--vscode-charts-blue, #3794ff); }
	.fill.c1 { background: var(--vscode-charts-green, #89d185); }
	.fill.c2 { background: var(--vscode-charts-purple, #b180d7); }
	.fill.c3 { background: var(--vscode-charts-orange, #d18616); }
	.fill.c4 { background: var(--vscode-charts-red, #f14c4c); }

	.srow {
		display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
		padding: 5px 6px; margin: 0 -6px; cursor: pointer; border-radius: 4px;
	}
	.srow:hover, .srow:focus-visible { background: var(--vscode-list-hoverBackground); }
	.srow:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
	.srow .main { min-width: 0; flex: 1 1 auto; }
	.srow .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.srow .m { font-size: 10px; color: var(--vscode-descriptionForeground); }
	.srow .r { flex: 0 0 auto; font-size: 10px; color: var(--vscode-descriptionForeground); opacity: .85; white-space: nowrap; }

	.linklike { cursor: pointer; }
	.linklike:hover { text-decoration: underline; }

	.arow { padding: 5px 6px 4px; margin: 0 -6px; cursor: pointer; border-radius: 4px; }
	.arow:hover, .arow:focus-visible { background: var(--vscode-list-hoverBackground); }
	.arow:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
	.arow .top { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
	.arow .aname { font-weight: 600; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.arow .acur { color: var(--vscode-charts-green, #89d185); margin-right: 3px; }
	.arow .amode {
		flex: 0 0 auto; font-size: 9px; color: var(--vscode-descriptionForeground);
		border: 1px solid var(--vscode-panel-border, var(--mm-track));
		border-radius: 8px; padding: 0 5px; line-height: 13px; white-space: nowrap;
	}
	.arow .aline2 {
		font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 1px;
		overflow-wrap: anywhere;
	}
	.arow.disconnected .aline2 { color: var(--vscode-textLink-foreground); }
	.adetail {
		background: var(--vscode-input-background, transparent);
		border: 1px solid var(--vscode-contrastBorder, transparent);
		border-radius: 5px; padding: 6px 8px; margin: 2px 0 4px; font-size: 10px;
	}
	.adrow { display: flex; justify-content: space-between; gap: 10px; padding: 1px 0; }
	.adrow .l { flex: 0 0 auto; color: var(--vscode-descriptionForeground); }
	.adrow .v { flex: 1 1 auto; text-align: right; min-width: 0; overflow-wrap: anywhere; }
	.adrow .v.mono {
		font-family: var(--vscode-editor-font-family, monospace);
		overflow-wrap: anywhere; letter-spacing: -0.5px;
	}
	.adstale { color: var(--vscode-editorWarning-foreground, #cca700); margin-top: 2px; }
	.adbtns { display: flex; gap: 10px; margin-top: 4px; }
	.adbtns .alink {
		color: var(--vscode-textLink-foreground); background: none; border: none;
		padding: 0; font-size: 10px; font-family: inherit; cursor: pointer;
	}
	.adbtns .alink:hover { text-decoration: underline; }

	.linkbtn {
		display: inline-block; margin-top: 6px; padding: 2px 0;
		color: var(--vscode-textLink-foreground); background: none; border: none;
		font-size: 11px; cursor: pointer; font-family: inherit;
	}
	.linkbtn:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }

	.btnrow { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
	.btnrow.top { margin: 0 0 10px; }
	.btn {
		flex: 1 1 auto; min-width: 64px;
		padding: 4px 8px; cursor: pointer; border-radius: 4px;
		font-size: 11px; font-family: inherit;
		border: 1px solid var(--vscode-contrastBorder, transparent);
		background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
		color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
		text-align: center; white-space: nowrap;
	}
	.btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
	.btn.primary {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
	}
	.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
	.btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

	.empty {
		padding: 14px 4px; text-align: center;
		color: var(--vscode-descriptionForeground); font-size: 11px;
	}
	[hidden] { display: none !important; }
</style>
</head>
<body>
	<div class="hdr">
		<div class="brand">ModelMeter<span class="ver" id="ver"></span></div>
		<div class="updated" id="updated"></div>
	</div>

	<div class="btnrow top">
		<button class="btn primary" data-msg="openOverview">打开用量总览</button>
	</div>

	<div class="hero" id="hero">
		<div class="cell"><div class="v" id="h-tokens">–</div><div class="l">Token（近 7 天）</div></div>
		<div class="cell"><div class="v" id="h-reqs">–</div><div class="l">请求</div></div>
		<div class="cell"><div class="v small" id="h-cost">–</div><div class="l">等效 API 成本</div><div class="l sub" id="h-cost-note">按官方按量价</div></div>
	</div>

	<div class="sec-h"><span>账户与套餐</span><span class="hint linklike" id="acct-manage" data-msg="manageAccounts" role="button" tabindex="0" aria-label="管理账户连接">管理…</span></div>
	<div id="accounts"></div>

	<div class="sec-h"><span>模型用量</span><span class="hint">近 7 天 · 按 Token</span></div>
	<div id="vendors"></div>

	<hr class="divider">

	<div class="sec-h"><span>最近会话</span><span class="hint" id="sess-count"></span></div>
	<div id="sessions"></div>
	<button class="linkbtn" id="more-sessions" hidden>查看全部会话 →</button>

	<div class="btnrow">
		<button class="btn" data-msg="refresh">重新统计</button>
		<button class="btn" data-msg="openHelp">帮助</button>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const SESSION_PREVIEW = 6;
		let allSessions = [];
		let sessionsHint = '';
		let expanded = false;
		let accountRows = [];
		let accountDetail = null;
		let accountExpanded = null;

		function esc(s) {
			return String(s)
				.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
		}

		function renderVendors(rows) {
			const host = document.getElementById('vendors');
			if (!rows.length) {
				host.innerHTML = '<div class="empty">暂无用量数据<br>使用 Copilot Chat 后这里会出现厂商与模型统计</div>';
				return;
			}
			host.innerHTML = rows.map(function (r) {
				// Bar width is applied later via CSSOM (el.style.width) — inline
				// style="" attributes would violate the strict style-src CSP.
				return '<div class="vrow" data-msg="openVendor" data-vendor-id="' + esc(r.id) + '" title="打开厂商用量" tabindex="0" role="button" aria-label="打开厂商用量：' + esc(r.name) + '">' +
					'<div class="top"><span class="name">' + esc(r.name) + '</span><span class="meta">' + esc(r.meta) + '</span></div>' +
					'<div class="track"><div class="fill c' + (r.color | 0) + '" data-w="' + (r.pct | 0) + '"></div></div>' +
					'</div>';
			}).join('');
			host.querySelectorAll('.fill').forEach(function (el) {
				el.style.width = (el.getAttribute('data-w') | 0) + '%';
			});
		}

		function renderSessions() {
			const host = document.getElementById('sessions');
			const count = document.getElementById('sess-count');
			const more = document.getElementById('more-sessions');
			count.textContent = allSessions.length ? (String(allSessions.length) + ' 个' + (sessionsHint ? ' · ' + sessionsHint : '')) : sessionsHint;
			if (!allSessions.length) {
				host.innerHTML = '<div class="empty">暂无会话<br>使用 Copilot Chat 后这里会出现会话记录</div>';
				more.hidden = true;
				return;
			}
			const shown = expanded ? allSessions : allSessions.slice(0, SESSION_PREVIEW);
			host.innerHTML = shown.map(function (s) {
				return '<div class="srow" data-msg="openSession" data-session-id="' + esc(s.id) + '" title="打开会话详情" tabindex="0" role="button" aria-label="打开会话详情：' + esc(s.title) + '">' +
					'<div class="main"><div class="t">' + esc(s.title) + '</div><div class="m">' + esc(s.meta) + '</div></div>' +
					'<div class="r">' + esc(s.right) + '</div>' +
					'</div>';
			}).join('');
			if (allSessions.length > SESSION_PREVIEW) {
				more.hidden = false;
				more.textContent = expanded ? '收起会话列表 ←' : ('查看全部会话（' + allSessions.length + '）→');
			} else {
				more.hidden = true;
			}
		}

		function renderAccounts() {
			const host = document.getElementById('accounts');
			if (!accountRows.length) {
				host.innerHTML = '<div class="empty">暂无账户配置</div>';
				return;
			}
			const html = accountRows.map(function (r) {
				const isExpanded = accountExpanded === r.id && accountDetail;
				let row = '<div class="arow' + (r.connected ? '' : ' disconnected') + '"' +
					' data-msg="' + (r.connected ? 'toggleAccount' : 'connectAccount') + '"' +
					' data-provider="' + esc(r.id) + '"' +
					' title="' + (r.connected ? '展开账户详情' : '点击连接账户') + '"' +
					' tabindex="0" role="button" aria-label="' + esc(r.name) + '：' + esc(r.line2) + '">' +
					'<div class="top"><span class="aname">' +
					(r.current ? '<span class="acur" title="当前使用模型所属账户">●</span>' : '') +
					esc(r.name) + '</span><span class="amode">' + esc(r.mode) + '</span></div>' +
					'<div class="aline2">' + esc(r.line2) + '</div></div>';
				if (isExpanded) { row += renderAccountDetail(accountDetail); }
				return row;
			}).join('');
			host.innerHTML = html;
		}

		function renderAccountDetail(d) {
			const rows = (d.rows || []).map(function (row) {
				const mono = String(row.value).indexOf('[') >= 0 ? ' mono' : '';
				return '<div class="adrow"><span class="l">' + esc(row.label) + '</span>' +
					'<span class="v' + mono + '">' + esc(row.value) + '</span></div>';
			}).join('');
			return '<div class="adetail" data-stop="1">' + rows +
				(d.stale ? '<div class="adstale">⚠ ' + esc(d.stale) + '</div>' : '') +
				'<div class="adbtns">' +
				'<button class="alink" data-msg="refreshAccount" data-provider="' + esc(d.provider) + '">↻ 刷新</button>' +
				'<button class="alink" data-msg="manageAccounts" data-provider="' + esc(d.provider) + '">管理 / 断开</button>' +
				'</div></div>';
		}

		function render(data) {
			document.getElementById('ver').textContent = data.version ? 'v' + data.version : '';
			document.getElementById('updated').textContent = data.generated ? ('更新于 ' + data.generated) : '';
			document.getElementById('h-tokens').textContent = data.week.tokens;
			document.getElementById('h-reqs').textContent = data.week.requests;
			document.getElementById('h-cost').textContent = data.week.cost;
			document.getElementById('h-cost-note').textContent = data.week.costNote;
			accountRows = data.accounts || [];
			accountDetail = data.accountDetail || null;
			accountExpanded = data.accountExpanded || null;
			renderAccounts();
			renderVendors(data.vendors || []);
			allSessions = data.sessions || [];
			sessionsHint = data.sessionsHint || '';
			renderSessions();
		}

		window.addEventListener('message', function (ev) {
			const msg = ev.data;
			if (msg && msg.type === 'data' && msg.payload) {
				render(msg.payload);
			} else if (msg && msg.type === 'focusAccount') {
				const host = document.getElementById('accounts');
				if (host && host.scrollIntoView) { host.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
			}
		});

		// Event delegation: data-msg attributes map to the host-side whitelist.
		document.addEventListener('click', function (ev) {
			// Clicks inside the detail card only act on the buttons (never collapse the row).
			if (ev.target && ev.target.closest && ev.target.closest('.adetail') && !ev.target.closest('.alink')) { return; }
			const el = ev.target && ev.target.closest ? ev.target.closest('[data-msg]') : null;
			if (!el) { return; }
			const msg = el.getAttribute('data-msg');
			if (msg === 'openSession') {
				vscode.postMessage({ type: 'openSession', sessionId: el.getAttribute('data-session-id') || '' });
			} else if (msg === 'openVendor') {
				vscode.postMessage({ type: 'openVendor', vendorId: el.getAttribute('data-vendor-id') || '' });
			} else if (msg === 'toggleAccount' || msg === 'refreshAccount' || msg === 'connectAccount' || msg === 'manageAccounts') {
				const provider = el.getAttribute('data-provider');
				vscode.postMessage(provider ? { type: msg, provider: provider } : { type: msg });
			} else {
				vscode.postMessage({ type: msg });
			}
		});

		document.getElementById('more-sessions').addEventListener('click', function (ev) {
			ev.stopPropagation();
			expanded = !expanded;
			renderSessions();
		});

		// Keyboard access for vendor/session rows: Enter / Space activate the
		// same message as a click (rows are tabindex=0, role=button).
		document.addEventListener('keydown', function (ev) {
			if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') { return; }
			var el = ev.target && ev.target.closest ? ev.target.closest('[data-msg][tabindex]') : null;
			if (!el) { return; }
			ev.preventDefault();
			el.click();
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
