/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * MiMo (Xiaomi) account adapter — PAYG balance + Token Plan windows.
 *
 * Sources (both verified in the reference implementations):
 *   - Buggo404/mimo-usage-monitor: `GET /api/v1/tokenPlan/usage` with console
 *     cookies; plan item `plan_total_token` {used, limit, percent}.
 *   - Javis603/token-monitor (mimo provider): additionally
 *     `GET /api/v1/balance` → `data.balance` (plus cash/gift split).
 * Base host: https://platform.xiaomimimo.com
 *
 * `percent` arrives as a 0–1 ratio (per the reference normalization); every
 * percent is converted to REMAINING in this adapter.
 */

import { httpText, parseJson, ProviderHttpError } from '../http';
import type { AccountSnapshot, AccountWindow } from '../types';
import { percentPointsFromRatioOrValue, toNumber } from './normalize';
import type { ProviderFetchOptions } from './shared';

const MIMO_BASE = 'https://platform.xiaomimimo.com';

function mimoHeaders(cookie: string): Record<string, string> {
	return {
		Cookie: normalizeCookie(cookie),
		Origin: MIMO_BASE,
		Referer: `${MIMO_BASE}/`,
		Accept: 'application/json',
		'Content-Type': 'application/json',
		'x-timezone': Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai',
	};
}

export function normalizeCookie(raw: string): string {
	return raw
		.replace(/^cookie\s*:\s*/i, '')
		.split(';')
		.map(c => c.trim())
		.filter(c => c.length > 0)
		.join('; ');
}

interface MimoUsageItem {
	name?: string;
	used?: unknown;
	limit?: unknown;
	percent?: unknown;
}

function windowFromItem(item: MimoUsageItem | undefined, id: string, label: string): AccountWindow | null {
	if (!item) { return null; }
	const used = toNumber(item.used);
	const limit = toNumber(item.limit);
	const usedPct = percentPointsFromRatioOrValue(item.percent, used, limit);
	if (usedPct === null && used === null && limit === null) { return null; }
	const window: AccountWindow = { id, label };
	if (used !== null) { window.used = used; }
	if (limit !== null) { window.limit = limit; }
	if (usedPct !== null) { window.remainingPercent = Math.max(0, Math.min(100, 100 - usedPct)); }
	return window;
}

export interface MimoParsed {
	balance?: { value: number; cash?: number; gift?: number };
	plan?: AccountWindow | null;
	month?: AccountWindow | null;
}

export function parseMimoBalance(text: string): MimoParsed['balance'] {
	const body = parseJson<{ code?: unknown; message?: unknown; data?: Record<string, unknown> }>(text);
	const code = toNumber(body.code);
	if (code !== null && code !== 0) {
		throw new Error(`MiMo balance API error: ${String((body.message as string) ?? code)}`);
	}
	const data = body.data ?? {};
	const value = toNumber(data.balance ?? data.totalBalance ?? data.amount);
	if (value === null) {
		throw new Error('MiMo balance response is missing a balance');
	}
	const cash = toNumber(data.cashBalance ?? data.cash_balance);
	const gift = toNumber(data.giftBalance ?? data.gift_balance);
	return {
		value,
		...(cash !== null ? { cash } : {}),
		...(gift !== null ? { gift } : {}),
	};
}

export function parseMimoUsage(text: string): { plan: AccountWindow | null; month: AccountWindow | null } {
	const body = parseJson<{ code?: unknown; message?: unknown; data?: { usage?: { items?: MimoUsageItem[]; percent?: unknown }; monthUsage?: { items?: MimoUsageItem[]; percent?: unknown } } }>(text);
	const code = toNumber(body.code);
	if (code !== null && code !== 0) {
		const message = String((body.message as string) ?? code);
		const err = new Error(`MiMo usage API error: ${message}`);
		if (/needlogin|not\s*login|登录|unauthor/i.test(message)) {
			(err as { kind?: string }).kind = 'unauthorized';
		}
		throw err;
	}
	const usage = body.data?.usage;
	const monthUsage = body.data?.monthUsage;
	const planItem = usage?.items?.find(i => i.name === 'plan_total_token') ?? usage?.items?.[0];
	const monthItem = monthUsage?.items?.find(i => i.name === 'month_total_token') ?? monthUsage?.items?.[0];
	let plan = windowFromItem(planItem, 'plan', '套餐');
	if (!plan && usage?.percent !== undefined) {
		plan = windowFromItem({ percent: usage.percent }, 'plan', '套餐');
	}
	return { plan, month: windowFromItem(monthItem, 'month', '月') };
}

export async function fetchMimoSnapshot(cookie: string, options: ProviderFetchOptions): Promise<AccountSnapshot> {
	const fetchedAt = options.now ?? Date.now();
	const headers = mimoHeaders(cookie);
	const balanceResult = await httpText(`${MIMO_BASE}/api/v1/balance`, {
		headers,
		fetchImpl: options.fetchImpl,
		timeoutMs: options.timeoutMs,
	});
	const balance = parseMimoBalance(balanceResult.text);
	if (!balance) {
		throw new ProviderHttpError('unavailable', 0, 'MiMo balance response was empty');
	}

	let plan: AccountWindow | null = null;
	let month: AccountWindow | null = null;
	try {
		const usageResult = await httpText(`${MIMO_BASE}/api/v1/tokenPlan/usage`, {
			headers,
			fetchImpl: options.fetchImpl,
			timeoutMs: options.timeoutMs,
		});
		const parsed = parseMimoUsage(usageResult.text);
		plan = parsed.plan;
		month = parsed.month;
	} catch (err) {
		// A PAYG-only account may not expose the Token Plan endpoint at all —
		// keep the balance and surface no plan windows (the reference monitor
		// behaves the same way). Auth failures still propagate.
		if ((err as { kind?: string }).kind === 'unauthorized') { throw err; }
	}

	const windows: AccountWindow[] = [];
	if (plan) { windows.push(plan); }
	if (month && month !== plan) { windows.push(month); }
	return {
		provider: 'mimo',
		billingMode: plan ? 'plan' : 'payg',
		balance: { value: balance.value, currency: 'CNY' },
		windows,
		source: 'official-console',
		fetchedAt,
	};
}
