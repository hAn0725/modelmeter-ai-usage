/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TreeNode, TreeNodeType } from './treeTypes';
import { getCatalogData } from './catalogData';
import { IDirectoryGroup } from '../types/directory';
import { TokenUsageTracker } from '../tokenUsage/tokenUsageTracker';
import { SessionSummary } from '../tokenUsage/metricsDatabase';
import { formatTokenCount, formatCnyCompact, combineToCny, localDateKey } from '../tokenUsage/tokenCostEstimator';

/** Stored session filter state shared across the tree provider's lifecycle. */
export interface SessionFilter {
	days: number;
	modelName?: string;
}

/** Help doc entries: label shown in tree → filename in help/ directory. */
const HELP_DOCS: { label: string; filename: string; description: string }[] = [
	{ label: '快速开始', filename: 'HELP_GETTING_STARTED.md', description: '安装、侧边栏与第一步操作' },
	{ label: 'Token 用量统计', filename: 'HELP_TOKEN_USAGE.md', description: '仪表盘、状态栏与会话分析' },
	{ label: '会话分析', filename: 'HELP_SESSION_ANALYTICS.md', description: '浏览会话、筛选与轮次详情' },
	{ label: '费用估算', filename: 'HELP_COST_ESTIMATES.md', description: '价格表如何工作与估算准确度' },
];

/**
 * Single unified TreeDataProvider for the Copilot Alternatives sidebar.
 */
export class TreeProvider implements vscode.TreeDataProvider<TreeNode> {
	private _onDidChangeTreeData = new vscode.EventEmitter<TreeNode | undefined>();
	readonly onDidChangeTreeData: vscode.Event<TreeNode | undefined> = this._onDidChangeTreeData.event;

	/** Directory catalog data — retained for data preservation; no longer rendered in the tree. */
	private _catalogGroups: readonly IDirectoryGroup[] = [];
	private _extensionPath: string;
	private _tokenTracker: TokenUsageTracker | undefined;
	private _sessionFilter: SessionFilter = { days: 7 };
	private readonly _helpDocs = HELP_DOCS;

	constructor(extensionPath: string, tokenTracker?: TokenUsageTracker) {
		this._extensionPath = extensionPath;
		this._tokenTracker = tokenTracker;
		this._catalogGroups = getCatalogData(extensionPath);
	}

	/**
	 * Force a full re-read of the catalog and refresh the whole tree.
	 */
	refresh(): void {
		// Re-read catalog (in case data changed, though normally cached)
		this._catalogGroups = getCatalogData(this._extensionPath);
		this._onDidChangeTreeData.fire(undefined);
	}

	/** Get/set the active session filter. */
	get sessionFilter(): SessionFilter { return this._sessionFilter; }
	set sessionFilter(f: SessionFilter) { this._sessionFilter = f; this.refresh(); }

	// ─── TreeDataProvider interface ─────────────────────────────────────────

	getTreeItem(element: TreeNode): vscode.TreeItem {
		return element.toTreeItem();
	}

	async getChildren(element?: TreeNode): Promise<TreeNode[]> {
		if (!element) {
			return this._getRootChildren();
		}

		switch (element.type) {
			case 'usageSection':
				return this._getUsageVendors();
			case 'usageVendor':
				return this._getUsageModels(element.label);
			case 'sessionSection':
				return this._getSessions();
			case 'helpSection':
				return this._getHelpDocs();
			default:
				return [];
		}
	}

	// ─── Root children ──────────────────────────────────────────────────────

	private async _getRootChildren(): Promise<TreeNode[]> {
		const nodes: TreeNode[] = [];

		// 1. Usage Stats (from SQLite DB, last 7 days)
		if (this._tokenTracker) {
			const vendors7d = await this._tokenTracker.metricsService.getVendorBreakdown7d();
			const totalTokens = vendors7d.reduce((sum, v) => sum + v.promptTokens + v.completionTokens, 0);
			const totalReqs = vendors7d.reduce((sum, v) => sum + v.requestCount, 0);
			const totalCost = vendors7d.reduce((sum, v) => sum + combineToCny(v.costUsd, v.costCny), 0);
			nodes.push(new TreeNode(
				'usageSection',
				'usage-section',
				'用量统计',
				undefined,
				`${formatTokenCount(totalTokens)} Token | ${totalReqs} 次请求 | 最近 7 天`,
				`${formatTokenCount(totalTokens)} Token、${totalReqs} 次请求、费用 ${formatCnyCompact(totalCost)} — 最近 7 天`,
			));

			// 2. Session Stats
			const sessions = await this._tokenTracker.metricsService.listSessions(this._sessionFilter.days, {
				modelName: this._sessionFilter.modelName,
			});
			const totalCostSession = sessions.reduce((s, sess) => s + combineToCny(sess.costUsd, sess.costCny), 0);
			const costLabel = formatCnyCompact(totalCostSession);
			const extraDesc = this._sessionFilter.modelName
				? ` · ${this._sessionFilter.modelName}`
				: '';
			nodes.push(new TreeNode(
				'sessionSection',
				'session-section',
				'会话统计',
				undefined,
				`最近 ${this._sessionFilter.days} 天${extraDesc} · ${sessions.length} 个会话 | ${costLabel}`,
				`${sessions.length} 个会话，费用 ${costLabel} — 最近 ${this._sessionFilter.days} 天`,
			));
		}

		// 3. Help section — always last
		nodes.push(new TreeNode(
			'helpSection',
			'help-section',
			'帮助',
			undefined,
			`${this._helpDocs.length} 篇指南`,
			'快速开始、用量统计、模型与厂商统计、会话分析、费用估算等指南',
		));

		return nodes;
	}

	// ─── Usage Stats ──────────────────────────────────────────────────────

	private async _getUsageVendors(): Promise<TreeNode[]> {
		if (!this._tokenTracker) { return []; }
		const vendors = await this._tokenTracker.metricsService.getVendorBreakdown7d();

		const nodes = vendors
			.sort((a, b) => (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens))
			.map(v => new TreeNode(
				'usageVendor',
				'usage-vendor:' + v.vendor,
				v.vendor,
				undefined,
				`${formatTokenCount(v.promptTokens + v.completionTokens)} | ${v.requestCount} 次请求 | 最近 7 天`,
				`${v.vendor}：${formatTokenCount(v.promptTokens + v.completionTokens)} Token、${v.requestCount} 次请求、费用 ${formatCnyCompact(combineToCny(v.costUsd, v.costCny))} — 最近 7 天`,
			));

		// Ensure "copilot" always appears, even when there's no data yet
		if (!vendors.some(v => v.vendor === 'copilot')) {
			nodes.unshift(new TreeNode(
				'usageVendor',
				'usage-vendor:copilot',
				'copilot',
				undefined,
				'暂无数据',
				'GitHub Copilot — 有用量数据后将显示在这里',
			));
		}

		return nodes;
	}

	private async _getUsageModels(vendor: string): Promise<TreeNode[]> {
		if (!this._tokenTracker) { return []; }
		const models = await this._tokenTracker.metricsService.getModelBreakdown7d(vendor);
		return models
			.sort((a, b) => (b.promptTokens + b.completionTokens) - (a.promptTokens + a.completionTokens))
			.map(m => {
				const lastSlash = m.modelId.lastIndexOf('/');
				const shortLabel = lastSlash === -1 ? m.modelId : m.modelId.slice(lastSlash + 1);
				return new TreeNode(
					'usageModel',
					'usage-model:' + m.modelId,
					shortLabel,
					undefined,
					`${formatTokenCount(m.promptTokens + m.completionTokens)} | ${m.requestCount} 次请求 | 最近 7 天`,
					`${m.modelId}：${formatTokenCount(m.promptTokens + m.completionTokens)} Token、${m.requestCount} 次请求、费用 ${formatCnyCompact(combineToCny(m.costUsd, m.costCny))} — 最近 7 天`,
				);
			});
	}

	// ─── Session Stats ────────────────────────────────────────────────────

	private async _getSessions(): Promise<TreeNode[]> {
		if (!this._tokenTracker) { return []; }

		const sessions = await this._tokenTracker.metricsService.listSessions(
			this._sessionFilter.days,
			{
				modelName: this._sessionFilter.modelName,
			},
		);

		if (sessions.length === 0) {
			return [new TreeNode(
				'sessionNode',
				'session:none',
				'未找到会话',
				undefined,
				this._hasActiveFilter() ? '请尝试调整筛选条件' : '使用 Copilot Chat 后，会话将显示在这里',
			)];
		}

		return sessions.map(s => {
			const dateStr = localDateKey(new Date(s.creation_date));
			const shortId = s.session_id.length > 8 ? s.session_id.substring(0, 8) : s.session_id;
			const vendorModel = [s.session_vendor, s.session_model_name].filter(Boolean).join('/') || 'unknown';
			const formattedTokens = formatTokenCount(s.totalTokens);
			const costLabel = formatCnyCompact(combineToCny(s.costUsd, s.costCny));

			return new TreeNode(
				'sessionNode',
				'session:' + s.session_id,
				`${dateStr} · ${shortId}`,
				s,
				`${s.turnCount} 轮 · ${vendorModel}`,
				`${s.turnCount} 轮、${formattedTokens} Token、${costLabel} — ${vendorModel}`,
			);
		});
	}

	private _hasActiveFilter(): boolean {
		return this._sessionFilter.days !== 7 || !!this._sessionFilter.modelName;
	}

	private _getHelpDocs(): TreeNode[] {
		return this._helpDocs.map(doc => new TreeNode(
			'helpItem',
			doc.filename,
			doc.label,
			undefined,
			doc.description,
		));
	}
}
