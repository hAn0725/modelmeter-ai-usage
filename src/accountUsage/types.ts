/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Account-usage domain types (ModelMeter 0.3.0).
 *
 * Everything a provider adapter produces is normalized into `AccountSnapshot`,
 * which only carries *account-level* facts: balance, plan, quota windows.
 * Local session/turn/token facts stay in the existing token-usage pipeline.
 *
 * Data-source layering (never mix):
 *  - official-api / official-console → provider API or console response
 *  - local                          → ModelMeter's own session observation
 *  - estimated                      → derived locally (clearly labelled ≈)
 */

export type AccountProviderId = 'deepseek' | 'glm' | 'qwen' | 'mimo';

export type AccountSource = 'official-api' | 'official-console';

export type BillingMode = 'payg' | 'plan';

/** Extra fields a balance payload may carry (DeepSeek grants / top-ups). */
export interface BalanceBreakdown {
	granted?: number;
	toppedUp?: number;
}

export interface AccountBalance {
	value: number;
	currency: string;
	breakdown?: BalanceBreakdown;
}

export interface AccountPlan {
	name?: string;
	expiresAt?: number;
}

/**
 * One quota window. Deliberately generic — providers differ in what windows
 * they expose (5h / weekly / monthly / plan totals); the core never hardcodes
 * five-hour or weekly as structural facts.
 */
export interface AccountWindow {
	/** Stable id, e.g. '5h' | 'week' | 'month' | 'mcp' | 'plan'. */
	id: string;
	label: string;
	used?: number;
	limit?: number;
	/** 0–100, already clamped by the provider adapter. */
	remainingPercent?: number;
	resetAt?: number;
	unit?: string;
}

export interface AccountSnapshot {
	provider: AccountProviderId;
	billingMode: BillingMode;
	balance?: AccountBalance;
	plan?: AccountPlan;
	windows: AccountWindow[];
	source: AccountSource;
	fetchedAt: number;
}

// ─── Runtime states ─────────────────────────────────────────────────────────

/**
 * `noPlan` is NOT a failure: the request succeeded but the account has no
 * Coding Plan / Token Plan subscription (PAYG-only accounts). The UI must
 * render it neutrally instead of “刷新失败”.
 */
export type AccountErrorKind = 'unauthorized' | 'rateLimited' | 'unavailable' | 'noPlan';

export interface AccountFetchError {
	kind: AccountErrorKind;
	message: string;
	at: number;
}

/**
 * Cached account state. A failed refresh NEVER clears `snapshot` — it only
 * records `lastError`, so the UI can keep showing the last good values with a
 * "刷新失败" annotation.
 */
export interface CachedAccount {
	snapshot: AccountSnapshot | null;
	/** Timestamp of the last successful fetch (or 0 when never). */
	updatedAt: number;
	lastError?: AccountFetchError;
	/** Cooldown for rate-limited providers (epoch ms, 0 = none). */
	retryNotBefore?: number;
}

export interface AccountViewState {
	provider: AccountProviderId;
	connected: boolean;
	cached: CachedAccount | null;
	region?: string;
}

// ─── Refresh policy constants ───────────────────────────────────────────────

/** TTL for the provider the user is actively generating with. */
export const CURRENT_PROVIDER_TTL_MS = 10 * 60 * 1000;
/** TTL for connected providers that are not currently active. */
export const OTHER_PROVIDER_TTL_MS = 30 * 60 * 1000;

export function isSnapshotStale(updatedAt: number, now: number, isCurrent: boolean): boolean {
	if (updatedAt <= 0) { return true; }
	const ttl = isCurrent ? CURRENT_PROVIDER_TTL_MS : OTHER_PROVIDER_TTL_MS;
	return now - updatedAt >= ttl;
}
