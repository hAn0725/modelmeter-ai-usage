/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * DeepSeek account adapter — PAYG balance.
 *
 * Source: official public API `GET /user/balance` (api.deepseek.com),
 * documented at api-docs.deepseek.com; also the read used by
 * Javis603/token-monitor's deepseek provider.
 * Auth: user's DeepSeek API key via `Authorization: Bearer <key>`.
 *
 * Response shape: `{ balance_infos: [{ currency, total_balance,
 * granted_balance, topped_up_balance }] }` (one row per currency).
 */

import { httpText, parseJson } from '../http';
import type { AccountSnapshot, BalanceBreakdown } from '../types';
import { firstString, toNumber } from './normalize';
import type { ProviderFetchOptions } from './shared';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';

interface BalanceRow {
	currency?: string;
	total_balance?: string | number;
	granted_balance?: string | number;
	topped_up_balance?: string | number;
	[key: string]: unknown;
}

export function parseDeepSeekBalance(text: string, fetchedAt: number): AccountSnapshot {
	const body = parseJson<{ balance_infos?: BalanceRow[] }>(text);
	const rows = Array.isArray(body.balance_infos) ? body.balance_infos : [];
	if (rows.length === 0) {
		throw new Error('DeepSeek balance response contains no balance rows');
	}
	// Prefer a funded row; fall back to the first (a zero-balance account is a
	// valid state and still shows ¥0.00).
	const funded = rows.find(r => (toNumber(r.total_balance) ?? 0) > 0) ?? rows[0];
	const total = toNumber(funded.total_balance);
	if (total === null) {
		throw new Error('DeepSeek balance row is missing total_balance');
	}
	const granted = toNumber(funded.granted_balance);
	const toppedUp = toNumber(funded.topped_up_balance);
	const breakdown: BalanceBreakdown = {};
	if (granted !== null) { breakdown.granted = granted; }
	if (toppedUp !== null) { breakdown.toppedUp = toppedUp; }

	return {
		provider: 'deepseek',
		billingMode: 'payg',
		balance: {
			value: total,
			currency: firstString(funded, ['currency']) || 'CNY',
			...(breakdown.granted !== undefined || breakdown.toppedUp !== undefined ? { breakdown } : {}),
		},
		windows: [],
		source: 'official-api',
		fetchedAt,
	};
}

export async function fetchDeepSeekSnapshot(apiKey: string, options: ProviderFetchOptions): Promise<AccountSnapshot> {
	const fetchedAt = options.now ?? Date.now();
	const { text } = await httpText(BALANCE_URL, {
		headers: {
			Authorization: `Bearer ${apiKey}`,
			Accept: 'application/json',
		},
		fetchImpl: options.fetchImpl,
		timeoutMs: options.timeoutMs,
	});
	return parseDeepSeekBalance(text, fetchedAt);
}
