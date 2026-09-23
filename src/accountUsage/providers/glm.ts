/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * GLM / Z.ai account adapter — Coding Plan quota.
 *
 * Source: `GET {base}/api/monitor/usage/quota/limit` with the user's API key.
 * The endpoint and its `data.limits[]` shape come from Z.ai's official plugin
 * (zai-org/zai-coding-plugins → glm-plan-usage/query-usage.mjs); the region
 * hosts and `Bearer` auth form follow Javis603/token-monitor's zai provider.
 *   global: https://api.z.ai        |  cn: https://open.bigmodel.cn
 *
 * `limits[]` entries (as produced by the official script + token-monitor):
 *   - TOKENS_LIMIT / CREDIT_LIMIT → token windows. `percentage` is 0–100 used;
 *     `usage`/`remaining`/`currentValue` allow an exact used% when present.
 *     `unit` (3 = hours, 5 = minutes, 1 = days, 6 = weeks) + `number` carry the
 *     window length and decide which limit is the 5-hour one (≤ 6h).
 *   - TIME_LIMIT → the monthly MCP bucket.
 * All percentages are converted to REMAINING in this adapter.
 */

import { httpText, parseJson } from '../http';
import type { AccountSnapshot, AccountWindow } from '../types';
import { clampPercent, firstString, percentPointsFromRatioOrValue, pick, toEpochMs, toNumber } from './normalize';
import type { ProviderFetchOptions } from './shared';

export function glmBaseUrl(region?: string): string {
	return region === 'cn' ? 'https://open.bigmodel.cn' : 'https://api.z.ai';
}

interface GlmLimit {
	type?: string;
	percentage?: unknown;
	usage?: unknown;
	remaining?: unknown;
	currentValue?: unknown;
	current_value?: unknown;
	nextResetTime?: unknown;
	next_reset_time?: unknown;
	unit?: unknown;
	number?: unknown;
	remaining_?: unknown;
}

export function glmWindowMinutes(unitRaw: unknown, numberRaw: unknown): number | null {
	const unit = toNumber(unitRaw);
	const number = toNumber(numberRaw);
	if (unit === null || number === null || number <= 0) { return null; }
	if (unit === 5) { return number; }               // minutes
	if (unit === 3) { return number * 60; }          // hours
	if (unit === 1) { return number * 24 * 60; }     // days
	if (unit === 6) { return number * 7 * 24 * 60; } // weeks
	return null;
}

/** Used percent for a limit entry — mirrors token-monitor's zaiUsedPercent. */
export function glmUsedPercent(limit: GlmLimit): number | null {
	const total = toNumber(limit.usage);
	const remaining = toNumber(limit.remaining);
	const currentValue = toNumber(limit.currentValue ?? limit.current_value);
	if (total !== null && total > 0) {
		let usedRaw: number | null = null;
		if (remaining !== null) {
			const usedFromRemaining = total - remaining;
			usedRaw = currentValue === null ? usedFromRemaining : Math.max(usedFromRemaining, currentValue);
		} else if (currentValue !== null) {
			usedRaw = currentValue;
		}
		if (usedRaw !== null) {
			return clampPercent((Math.max(0, Math.min(total, usedRaw)) / total) * 100);
		}
	}
	const pct = percentPointsFromRatioOrValue(limit.percentage, currentValue, total);
	return pct;
}

export function parseGlmQuota(text: string, fetchedAt: number): AccountSnapshot {
	const body = parseJson<{ code?: unknown; data?: unknown }>(text);
	const code = toNumber(body.code);
	if (code === 401 || code === 403) {
		const err = new Error(`GLM quota request answered business code ${code}`);
		(err as { kind?: string }).kind = 'unauthorized';
		throw err;
	}
	if (code !== null && code !== 200 && code !== 0) {
		// Business-level refusal. When the official message says the account has
		// no Coding Plan (PAYG-only account) this is NOT a failure — classify it
		// as `noPlan` so the UI renders a neutral state instead of “刷新失败”.
		const msg = firstString(body as Record<string, unknown>, ['msg', 'message']);
		const err = new Error(`GLM quota request answered business code ${code}${msg ? ` — ${msg}` : ''}`.slice(0, 190));
		(err as { kind?: string }).kind = /coding\s*plan|不存在.*plan|未开通.*plan/i.test(msg) ? 'noPlan' : 'unavailable';
		throw err;
	}
	const data = body.data as Record<string, unknown> | undefined;
	const limits = Array.isArray(data?.limits) ? (data.limits as GlmLimit[]) : [];
	const tokenLimits: { limit: GlmLimit; minutes: number | null }[] = [];
	let mcpLimit: GlmLimit | null = null;
	for (const limit of limits) {
		const type = String(limit?.type ?? '').trim().toUpperCase();
		if ((type === 'TOKENS_LIMIT' || type === 'CREDIT_LIMIT') && glmUsedPercent(limit) !== null) {
			tokenLimits.push({ limit, minutes: glmWindowMinutes(limit.unit, limit.number) });
		} else if (type === 'TIME_LIMIT' && glmUsedPercent(limit) !== null) {
			mcpLimit = limit ?? mcpLimit;
		}
	}
	if (tokenLimits.length === 0 && !mcpLimit) {
		// Diagnostic (structure only — field NAMES, never values/credentials):
		// helps adapt to account variants whose limits[] differ from the
		// reference implementations (e.g. an account without a Coding Plan).
		const dataRecord = (data ?? {}) as Record<string, unknown>;
		const dataKeys = Object.keys(dataRecord).slice(0, 12).join('|');
		const limitsType = Array.isArray(dataRecord.limits) ? 'array' : typeof dataRecord.limits;
		const limitShapes = limits.slice(0, 3).map(l => {
			const type = String(l?.type ?? 'null');
			const keys = Object.keys(l ?? {}).slice(0, 10).join('|');
			return `[type:${type} keys:${keys}]`;
		}).join(' ');
		throw new Error(`GLM quota response contains no usable limits (code ${String(body.code)}; dataKeys [${dataKeys}]; limitsType ${limitsType}; count ${limits.length} ${limitShapes})`.slice(0, 190));
	}
	// Shortest window first; entries without a decodable window length go last.
	tokenLimits.sort((a, b) => (a.minutes ?? Number.MAX_SAFE_INTEGER) - (b.minutes ?? Number.MAX_SAFE_INTEGER));

	const windows: AccountWindow[] = [];
	const mkWindow = (limit: GlmLimit, id: string, label: string): AccountWindow => {
		const used = glmUsedPercent(limit) ?? 0;
		return {
			id,
			label,
			remainingPercent: clampPercent(100 - used),
			resetAt: toEpochMs(limit.nextResetTime ?? limit.next_reset_time),
		};
	};
	if (tokenLimits.length >= 2) {
		windows.push(mkWindow(tokenLimits[0].limit, '5h', '5h'));
		windows.push(mkWindow(tokenLimits[tokenLimits.length - 1].limit, 'week', '周'));
	} else if (tokenLimits.length === 1) {
		const only = tokenLimits[0];
		const isSession = only.minutes !== null && only.minutes <= 6 * 60;
		windows.push(mkWindow(only.limit, isSession ? '5h' : 'plan', isSession ? '5h' : '套餐'));
	}
	if (mcpLimit) {
		windows.push(mkWindow(mcpLimit, 'mcp', 'MCP（月）'));
	}

	const planName = firstString(data, ['planName', 'plan_name', 'packageName', 'package_name']) || 'Coding Plan';
	return {
		provider: 'glm',
		billingMode: 'plan',
		plan: { name: planName },
		windows,
		source: 'official-api',
		fetchedAt,
	};
}

// ─── PAYG balance (prepaid accounts) ───────────────────────────────────────
// Verified against hucuyuu/zhipu-balance: bigmodel's business endpoint for the
// account report answers to the same API Key (Bearer) as the model APIs.
// Response: { success, data: { availableBalance, rechargeAmount,
// totalSpendAmount, frozenBalance }, code, msg } (amounts are strings).
const GLM_BALANCE_URL = 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report';

export function parseGlmBalance(text: string, fetchedAt: number): AccountSnapshot {
	const body = parseJson<{ success?: unknown; code?: unknown; msg?: unknown; data?: Record<string, unknown> }>(text);
	const bizCode = toNumber(body.code);
	const rejected = body.success === false || (bizCode !== null && bizCode !== 200 && bizCode !== 0);
	if (rejected) {
		const msg = firstString(body as Record<string, unknown>, ['msg', 'message']);
		const err = new Error(`GLM balance request rejected (code ${bizCode ?? '?'}${msg ? ` — ${msg}` : ''})`.slice(0, 190));
		(err as { kind?: string }).kind = bizCode === 401 || bizCode === 403 ? 'unauthorized' : 'unavailable';
		throw err;
	}
	const data = body.data ?? {};
	const available = toNumber(pick(data, ['availableBalance', 'available_balance']));
	if (available === null) {
		throw new Error('GLM balance response is missing availableBalance');
	}
	return {
		provider: 'glm',
		billingMode: 'payg',
		balance: { value: available, currency: 'CNY' },
		windows: [],
		source: 'official-api',
		fetchedAt,
	};
}

async function fetchGlmPlanSnapshot(apiKey: string, options: ProviderFetchOptions, fetchedAt: number): Promise<AccountSnapshot> {
	const url = `${glmBaseUrl(options.region)}/api/monitor/usage/quota/limit`;
	const { text } = await httpText(url, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: 'application/json',
			'Accept-Language': 'en-US,en',
		},
		fetchImpl: options.fetchImpl,
		timeoutMs: options.timeoutMs,
	});
	return parseGlmQuota(text, fetchedAt);
}

async function fetchGlmBalanceSnapshot(apiKey: string, options: ProviderFetchOptions, fetchedAt: number): Promise<AccountSnapshot> {
	const { text } = await httpText(GLM_BALANCE_URL, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: 'application/json',
		},
		fetchImpl: options.fetchImpl,
		timeoutMs: options.timeoutMs,
	});
	return parseGlmBalance(text, fetchedAt);
}

/**
 * Plan quota first; when the official answer is `noPlan` (PAYG-only account)
 * fall back to the prepaid balance endpoint — cn host only, since the balance
 * endpoint lives on open.bigmodel.cn.
 *
 * On the cn host a *successful* plan snapshot additionally carries the prepaid
 * balance (attached silently: the optional balance call must never drag down
 * the plan data), so “Coding Plan + 按量余额” accounts show both.
 */
export async function fetchGlmSnapshot(apiKey: string, options: ProviderFetchOptions): Promise<AccountSnapshot> {
	const fetchedAt = options.now ?? Date.now();
	try {
		const snapshot = await fetchGlmPlanSnapshot(apiKey, options, fetchedAt);
		if (glmBaseUrl(options.region) === 'https://open.bigmodel.cn') {
			try {
				const withBalance = await fetchGlmBalanceSnapshot(apiKey, options, fetchedAt);
				if (withBalance.balance) { snapshot.balance = withBalance.balance; }
			} catch { /* optional add-on — keep the plan snapshot as-is */ }
		}
		return snapshot;
	} catch (err) {
		if ((err as { kind?: string }).kind !== 'noPlan') { throw err; }
		if (glmBaseUrl(options.region) !== 'https://open.bigmodel.cn') { throw err; }
		try {
			return await fetchGlmBalanceSnapshot(apiKey, options, fetchedAt);
		} catch (balanceErr) {
			if ((balanceErr as { kind?: string }).kind === 'unauthorized') {
				throw err; // keep the authoritative “no coding plan” answer
			}
			throw balanceErr;
		}
	}
}

// re-exported for tests that build fixtures from raw limit entries
export type { GlmLimit };
export { pick };
