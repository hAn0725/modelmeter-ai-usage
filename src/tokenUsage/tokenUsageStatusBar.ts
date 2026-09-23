/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TokenUsageTracker } from './tokenUsageTracker';
import type { AccountUsageService } from '../accountUsage/accountUsageService';
import type { AccountProviderId } from '../accountUsage/types';
import { ACCOUNT_PROVIDERS, getProviderDef } from '../accountUsage/providerRegistry';
import { buildStatusBarText, buildStatusBarTooltip, type OtherAccountLine, type StatusBarInput } from '../accountUsage/statusBarModel';

/** Identity of the model the user is currently generating with. */
export interface StatusBarContext {
	providerId: AccountProviderId | null;
	modelId: string | null;
}

/**
 * 0.3.0 account-centric status bar:
 *   `$(flame) ModelMeter` when no provider is recognised,
 *   `$(flame) DeepSeek ¥38.62` for PAYG balances,
 *   `$(flame) GLM [████░░] 68%` for plan quota (REMAINING precentage),
 * and a rich markdown tooltip. Repaints every 60 s refresh only the *text*
 * (relative timestamps) — they never trigger HTTP requests; actual account
 * data refreshes are driven by the AccountUsageService TTL policy.
 */
export class TokenUsageStatusBar implements vscode.Disposable {
	private readonly _item: vscode.StatusBarItem;
	private _repaintTimer: ReturnType<typeof setInterval> | undefined;
	private _inputs: StatusBarInput | null = null;
	private _updating = false;
	private _updatePending = false;

	constructor(
		_tracker: TokenUsageTracker,
		private readonly _accounts: AccountUsageService,
		private readonly _getContext: () => StatusBarContext,
		private readonly _getLocalTotals: (provider: AccountProviderId) => Promise<{ tokens: number; costCny: number }>,
	) {
		this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
		this._item.command = 'modelMeter.showAccountSection';
		this._item.text = '$(flame) ModelMeter';
		this._item.tooltip = 'ModelMeter：正在读取…';
		this._item.show();
		this._repaintTimer = setInterval(() => this.renderNow(), 60_000);
		void this.update();
	}

	/** Re-read local + account state and repaint. Safe to call on every change. */
	update(): void { void this._update(); }

	/** Text-only repaint (no IO, no HTTP) — used by the 60 s timer. */
	renderNow(): void {
		if (!this._inputs) { return; }
		this._inputs.now = Date.now();
		this._item.text = buildStatusBarText(this._inputs);
		this._item.tooltip = buildStatusBarTooltip(this._inputs);
	}

	private async _update(): Promise<void> {
		if (this._updating) { this._updatePending = true; return; }
		this._updating = true;
		try {
			this._inputs = await this._buildInputs();
			this.renderNow();
		} catch {
			// Status bar must never throw; keep the previous text.
		} finally {
			this._updating = false;
			if (this._updatePending) {
				this._updatePending = false;
				void this._update();
			}
		}
	}

	private async _buildInputs(): Promise<StatusBarInput> {
		const ctx = this._getContext();
		const def = ctx.providerId ? getProviderDef(ctx.providerId) : undefined;
		const state = ctx.providerId ? this._accounts.get(ctx.providerId) : null;

		let localTokens: number | null = null;
		let localCostCny: number | null = null;
		if (ctx.providerId) {
			try {
				const totals = await this._getLocalTotals(ctx.providerId);
				localTokens = totals.tokens;
				localCostCny = totals.costCny;
			} catch {
				// Local aggregation failure only drops the ≈ line.
			}
		}

		const others: OtherAccountLine[] = ACCOUNT_PROVIDERS
			.filter(p => p.id !== ctx.providerId)
			.map(p => ({ name: p.displayName, snapshot: this._accounts.get(p.id).cached?.snapshot ?? null }));

		return {
			providerName: def?.displayName ?? null,
			currentModel: ctx.modelId,
			connected: state?.connected ?? false,
			snapshot: state?.cached?.snapshot ?? null,
			lastError: state?.cached?.lastError
				? { kind: state.cached.lastError.kind, message: state.cached.lastError.message, at: state.cached.lastError.at }
				: null,
			updatedAt: state?.cached?.updatedAt ?? 0,
			localCostCny,
			localTokens,
			others,
			now: Date.now(),
		};
	}

	dispose(): void {
		if (this._repaintTimer !== undefined) {
			clearInterval(this._repaintTimer);
			this._repaintTimer = undefined;
		}
		this._item.dispose();
	}
}