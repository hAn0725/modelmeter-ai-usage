/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TokenUsageTracker } from './tokenUsageTracker';
import { formatCnyCompact, formatTokenCount, combineToCny } from './tokenCostEstimator';
import { DashboardSummary } from './metricsDatabase';

export class TokenUsageStatusBar implements vscode.Disposable {
	private readonly _item: vscode.StatusBarItem;
	private _refreshing = false;
	private _refreshPending = false;

	constructor(private readonly _tracker: TokenUsageTracker) {
		this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
		this._item.command = 'modelMeter.showTokenUsage';
		this._item.text = '$(flame) …';
		this._item.show();
		void this._update();
	}

	/** Call this whenever new data arrives. */
	update(): void { void this._update(); }

	private async _update(): Promise<void> {
		if (this._refreshing) { this._refreshPending = true; return; }
		this._refreshing = true;
		try {
			const summary = await this._tracker.metricsService.getDashboardSummary();
			const todayTokens = summary.today.totalPromptTokens + summary.today.totalCompletionTokens;
			const todayCost = combineToCny(summary.today.estimatedCostUsd, summary.today.estimatedCostCny);

			this._item.text = `$(flame) ${formatTokenCount(todayTokens)} · ${formatCnyCompact(todayCost)}`;
			this._item.tooltip = this._buildTooltip(summary);
		} finally {
			this._refreshing = false;
			if (this._refreshPending) {
				this._refreshPending = false;
				void this._update();
			}
		}
	}

	private _buildTooltip(summary: DashboardSummary): string {
		const day24 = { tokens: summary.today.totalPromptTokens + summary.today.totalCompletionTokens, cost: combineToCny(summary.today.estimatedCostUsd, summary.today.estimatedCostCny) };
		const week = summary.thisWeek.reduce((a, d) => ({
			tokens: a.tokens + d.totalPromptTokens + d.totalCompletionTokens,
			cost: a.cost + combineToCny(d.estimatedCostUsd, d.estimatedCostCny),
		}), { tokens: 0, cost: 0 });
		const month = summary.thisMonth.reduce((a, d) => ({
			tokens: a.tokens + d.totalPromptTokens + d.totalCompletionTokens,
			cost: a.cost + combineToCny(d.estimatedCostUsd, d.estimatedCostCny),
		}), { tokens: 0, cost: 0 });

		const lines: string[] = ['Token 用量'];

		lines.push(
			`过去 24 小时：${formatTokenCount(day24.tokens)}  ${formatCnyCompact(day24.cost)}`,
			`过去 7 天：  ${formatTokenCount(week.tokens)}  ${formatCnyCompact(week.cost)}`,
			`过去 30 天： ${formatTokenCount(month.tokens)}  ${formatCnyCompact(month.cost)}`,
		);

		lines.push('', '点击打开用量总览');
		return lines.join('\n');
	}

	dispose(): void { this._item.dispose(); }
}