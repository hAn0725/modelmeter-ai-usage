/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TokenUsageTracker } from './tokenUsageTracker';
import type { AccountUsageService } from '../accountUsage/accountUsageService';
import type { AccountProviderId } from '../accountUsage/types';
import { ACCOUNT_PROVIDERS, getProviderDef } from '../accountUsage/providerRegistry';
import { buildStatusBarText, buildStatusBarTooltip, type ActiveSessionInput, type OtherAccountLine, type StatusBarInput } from '../accountUsage/statusBarModel';
import type { ILogService } from '../platform/log/common/logService';

/** Identity of the model the user is currently generating with. */
export interface StatusBarContext {
	providerId: AccountProviderId | null;
	modelId: string | null;
}

/** Abandon a hung local query so it can never block later repaints. */
const QUERY_TIMEOUT_MS = 5_000;
/** Safety net: re-query even if every change event is somehow missed. */
const REFRESH_INTERVAL_MS = 30_000;
/** After a failed refresh (e.g. a DB write lock), retry quickly. */
const RETRY_DELAY_MS = 5_000;

/**
 * Account-centric status bar (0.4.x):
 *   `$(flame) DeepSeek · 本轮 87.4K · 42 tok/s · ≈¥0.53 · 余额 ¥29.38`
 * Segments appear as data becomes available; unknown provider → `ModelMeter`.
 * Clicking focuses the existing sidebar (no second view is created).
 *
 * Robustness contract — a repaint can never be lost:
 *  - every `update()` runs its own time-bounded queries (no single-flight
 *    gate: one hung query used to silence the status bar forever);
 *  - a failed/timed-out refresh is logged and the next event retries;
 *  - the 30 s interval and window focus both re-query as a safety net.
 * Queries are local only — this class never triggers HTTP requests.
 */
export class TokenUsageStatusBar implements vscode.Disposable {
	private readonly _item: vscode.StatusBarItem;
	private _refreshTimer: ReturnType<typeof setInterval> | undefined;
	private _focusSub: vscode.Disposable | undefined;
	private _retryTimer: ReturnType<typeof setTimeout> | undefined;
	private _inputs: StatusBarInput | null = null;
	private _seq = 0;

	constructor(
		_tracker: TokenUsageTracker,
		private readonly _accounts: AccountUsageService,
		private readonly _getContext: () => StatusBarContext,
		private readonly _getLocalTotals: (provider: AccountProviderId) => Promise<{ tokens: number; costCny: number }>,
		private readonly _getSessionMetrics: () => Promise<ActiveSessionInput | null>,
		private readonly _log?: ILogService,
	) {
		this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 50);
		this._item.command = 'modelMeter.showAccountSection';
		this._item.text = '$(flame) ModelMeter';
		this._item.tooltip = 'ModelMeter：正在读取…';
		this._item.show();
		this._refreshTimer = setInterval(() => this.update(), REFRESH_INTERVAL_MS);
		this._focusSub = vscode.window.onDidChangeWindowState(e => { if (e.focused) { this.update(); } });
		void this.update();
	}

	/** Re-read local + account state and repaint. Safe to call on every change. */
	update(): void {
		const seq = ++this._seq;
		void this._runUpdate(seq);
	}

	private async _runUpdate(seq: number): Promise<void> {
		try {
			const inputs = await withTimeout(this._buildInputs(), QUERY_TIMEOUT_MS);
			if (seq !== this._seq) { return; } // superseded by a newer update
			this._inputs = inputs;
			this.renderNow();
		} catch (err) {
			this._log?.warn(`status bar refresh failed: ${err instanceof Error ? err.message : String(err)}`);
			// Contention (e.g. another ModelMeter instance importing) usually
			// clears within seconds — retry soon instead of waiting a full cycle.
			if (seq === this._seq) {
				if (this._retryTimer !== undefined) { clearTimeout(this._retryTimer); }
				this._retryTimer = setTimeout(() => { this._retryTimer = undefined; this.update(); }, RETRY_DELAY_MS);
			}
		}
	}

	/** Repaint from the last snapshot (no IO, no HTTP). */
	renderNow(): void {
		if (!this._inputs) { return; }
		this._inputs.now = Date.now();
		try {
			this._item.text = buildStatusBarText(this._inputs);
			this._item.tooltip = buildStatusBarTooltip(this._inputs);
		} catch (err) {
			this._log?.warn(`status bar render failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async _buildInputs(): Promise<StatusBarInput> {
		const ctx = this._getContext();
		const def = ctx.providerId ? getProviderDef(ctx.providerId) : undefined;
		const state = ctx.providerId ? this._accounts.get(ctx.providerId) : null;

		let localTokens: number | null = null;
		let localCostCny: number | null = null;
		let session: ActiveSessionInput | null = null;
		// Both queries in parallel — halves the worst-case latency while another
		// writer (or another ModelMeter window) briefly holds the database.
		const [totalsResult, sessionResult] = await Promise.allSettled([
			ctx.providerId ? this._getLocalTotals(ctx.providerId) : Promise.resolve(null),
			this._getSessionMetrics(),
		]);
		if (totalsResult.status === 'fulfilled') {
			if (totalsResult.value) {
				localTokens = totalsResult.value.tokens;
				localCostCny = totalsResult.value.costCny;
			}
		} else {
			// Local aggregation failure only drops the ≈ line.
			this._log?.warn(`local totals failed: ${totalsResult.reason instanceof Error ? totalsResult.reason.message : String(totalsResult.reason)}`);
		}
		if (sessionResult.status === 'fulfilled') {
			session = sessionResult.value;
		} else {
			// Session metrics are additive; never fail the whole render.
			this._log?.warn(`session metrics failed: ${sessionResult.reason instanceof Error ? sessionResult.reason.message : String(sessionResult.reason)}`);
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
			session,
			others,
			now: Date.now(),
		};
	}

	dispose(): void {
		if (this._refreshTimer !== undefined) {
			clearInterval(this._refreshTimer);
			this._refreshTimer = undefined;
		}
		if (this._retryTimer !== undefined) {
			clearTimeout(this._retryTimer);
			this._retryTimer = undefined;
		}
		this._focusSub?.dispose();
		this._focusSub = undefined;
		this._item.dispose();
	}
}

/** Reject after `ms` so a hung query cannot hold an update open forever. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
		promise.then(
			value => { clearTimeout(timer); resolve(value); },
			err => { clearTimeout(timer); reject(err); },
		);
	});
}