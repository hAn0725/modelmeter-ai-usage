/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Qwen / Alibaba Token Plan adapter — rolling 5h + weekly quota windows.
 *
 * Sources (two independent verified implementations, same ONE_CONSOLE contract):
 *   - PeachGumi/QwenUsage (intl): login state via
 *     `GET home.qwencloud.com/tool/user/info.json` → `data.secToken`; quota via
 *     `POST cs-data.qwencloud.com/data/api.json` with
 *     `zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/{subscription,quota-config,usage}`,
 *     `specCode` → `{five_hour, weekly}` totals, usage percentages
 *     `per5HourPercentage` / `per1WeekPercentage` (0–1 ratios) and reset epochs
 *     `per5HourResetTime` / `per1WeekResetTime`.
 *   - Javis603/token-monitor (alibaba provider): same gateway contract; region
 *     hosts and `cornerstoneParam` envelope (cn verified against a real
 *     account).
 *
 * Regions (adapter config, minimal pick in the connect flow):
 *   cn   : info bailian.console.aliyun.com   / quota bailian-cs.console.aliyun.com
 *          action BroadScopeAspnGateway      / consoleSite BAILIAN_ALIYUN
 *   intl : info home.qwencloud.com           / quota cs-data.qwencloud.com
 *          action IntlBroadScopeAspnGateway  / consoleSite QWENCLOUD
 *
 * Auth: console Cookie header (browser login or manual paste); non-sensitive.
 * Only balance/quota/plan-window fields leave this adapter — sec_token,
 * commodityCode and gateway internals never reach the UI.
 */

import { randomUUID } from 'crypto';
import { httpText, parseJson, ProviderHttpError } from '../http';
import type { AccountSnapshot, AccountWindow } from '../types';
import { percentPointsFromRatioOrValue, toEpochMs, toNumber } from './normalize';
import type { ProviderFetchOptions } from './shared';
import { fetchAliyunBalance } from '../aliyunBss';

interface QwenRegionConfig {
	infoHost: string;
	quotaHost: string;
	action: string;
	consoleSite: string;
	commodityCode: string;
	region: string;
	/** Host used in cornerstoneParam.domain. */
	domain: string;
}

export function qwenRegionConfig(region?: string): QwenRegionConfig {
	if (region === 'cn') {
		return {
			infoHost: 'https://bailian.console.aliyun.com',
			quotaHost: 'https://bailian-cs.console.aliyun.com',
			action: 'BroadScopeAspnGateway',
			consoleSite: 'BAILIAN_ALIYUN',
			commodityCode: 'sfm_tokenplansolo_public_cn',
			region: 'cn-beijing',
			domain: 'bailian.console.aliyun.com',
		};
	}
	return {
		infoHost: 'https://home.qwencloud.com',
		quotaHost: 'https://cs-data.qwencloud.com',
		action: 'IntlBroadScopeAspnGateway',
		consoleSite: 'QWENCLOUD',
		commodityCode: 'sfm_tokenplansolo_public_intl',
		region: 'ap-southeast-1',
		domain: 'home.qwencloud.com',
	};
}

export function normalizeQwenCookie(raw: string): string {
	return raw
		.replace(/^cookie\s*:\s*/i, '')
		.split(';')
		.map(c => c.trim())
		.filter(c => c.length > 0)
		.join('; ');
}

// ─── Payload traversal ──────────────────────────────────────────────────────
// The ONE_CONSOLE gateway double-stringifies nested JSON and does not commit
// to a fixed depth; expand embedded JSON strings, then search by key.

export function expandEmbeddedJson(value: unknown): unknown {
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) { return value; }
		try {
			return expandEmbeddedJson(JSON.parse(trimmed));
		} catch {
			return value;
		}
	}
	if (Array.isArray(value)) { return value.map(expandEmbeddedJson); }
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out[k] = expandEmbeddedJson(v); }
		return out;
	}
	return value;
}

/** First object anywhere in the tree that owns any of `keys` (case-insensitive). */
export function findObjectWithAnyKey(value: unknown, keys: string[]): Record<string, unknown> | null {
	const wanted = keys.map(k => k.toLowerCase());
	if (value && typeof value === 'object' && !Array.isArray(value)) {
		const record = value as Record<string, unknown>;
		if (Object.keys(record).some(k => wanted.includes(k.toLowerCase()))) { return record; }
		for (const nested of Object.values(record)) {
			const found = findObjectWithAnyKey(nested, keys);
			if (found) { return found; }
		}
		return null;
	}
	if (Array.isArray(value)) {
		for (const item of value) {
			const found = findObjectWithAnyKey(item, keys);
			if (found) { return found; }
		}
	}
	return null;
}

function looksLikeLoginFailure(text: string): boolean {
	return /consoleneedlogin|needlogin|notlogined|tokenerror|request has expired|请求已经过期|\blogin\b/i.test(text);
}

/** Parse user/info.json: returns the secToken. Throws unauthorized when signed out. */
export function parseQwenUserInfo(text: string): string {
	const body = parseJson<{ code?: unknown; data?: Record<string, unknown> }>(text);
	const code = String(body.code ?? '');
	if (looksLikeLoginFailure(code)) {
		throw new ProviderHttpError('unauthorized', 401, 'Qwen console session is signed out');
	}
	const token = body.data?.secToken ?? body.data?.sec_token;
	return typeof token === 'string' ? token.trim() : '';
}

export interface QwenUsageParsed {
	planName: string;
	windows: AccountWindow[];
}

/** Keys-only structure summary for diagnostics (never includes values). */
export function summarizeShape(value: unknown, maxEntries = 14): string {
	const parts: string[] = [];
	const walk = (node: unknown, prefix: string, depth: number): void => {
		if (parts.length >= maxEntries || depth > 3) { return; }
		if (Array.isArray(node)) {
			if (node.length > 0) { walk(node[0], `${prefix}[]`, depth + 1); }
			return;
		}
		if (node && typeof node === 'object') {
			for (const key of Object.keys(node as Record<string, unknown>)) {
				if (parts.length >= maxEntries) { return; }
				const childPath = prefix ? `${prefix}.${key}` : key;
				parts.push(childPath);
				walk((node as Record<string, unknown>)[key], childPath, depth + 1);
			}
		}
	};
	walk(value, '', 0);
	return parts.slice(0, maxEntries).join(', ').slice(0, 170);
}

/** Official business-error detail (code + msg) for diagnostics — no credentials. */
export function qwenFailureDetail(body: unknown): string {
	const frame = findObjectWithAnyKey(body, ['requestId', 'request_id'])
		?? findObjectWithAnyKey(body, ['msg', 'message']);
	if (!frame) { return ''; }
	const bits: string[] = [];
	if (frame.code !== undefined) { bits.push(`code ${String(frame.code)}`); }
	const msg = typeof frame.msg === 'string' ? frame.msg : (typeof frame.message === 'string' ? frame.message : '');
	if (msg) { bits.push(msg); }
	return bits.length > 0 ? ` — ${bits.join(': ')}` : '';
}

/** Parse the usage payload (+ optional specCode / quota totals). */
export function parseQwenUsage(usageText: string, specCode: string | null, quotaTotals: { fiveHour: number | null; weekly: number | null }): QwenUsageParsed {
	const body = expandEmbeddedJson(parseJson<unknown>(usageText));
	const usage = findObjectWithAnyKey(body, ['per5HourPercentage', 'per1weekpercentage', 'per5hourpercentage']);
	if (!usage) {
		const source = JSON.stringify(body).slice(0, 400);
		if (looksLikeLoginFailure(source)) {
			throw new ProviderHttpError('unauthorized', 401, 'Qwen console session is signed out');
		}
		// Last-resort structure dump: official msg/code values PLUS the DataV2
		// envelope field NAMES (never credentials) — required to adapt to
		// account variants (e.g. an account without a Token Plan) precisely.
		const holder = findObjectWithAnyKey(body, ['DataV2', 'datav2']);
		const dv2 = holder ? (holder['DataV2'] ?? holder['datav2']) : undefined;
		const dv2Record = dv2 && typeof dv2 === 'object' && !Array.isArray(dv2) ? dv2 as Record<string, unknown> : null;
		const envelope = findObjectWithAnyKey(dv2Record ?? body, ['requestId', 'request_id']);
		const ret = dv2Record ? String(dv2Record.ret ?? dv2Record.status ?? '?') : '?';
		const code = envelope && envelope.code !== undefined ? String(envelope.code) : '';
		const msg = envelope
			? (typeof envelope.msg === 'string' ? envelope.msg : typeof envelope.message === 'string' ? envelope.message : '')
			: '';
		const v2Keys = dv2Record ? Object.keys(dv2Record).join('|') : 'none';
		const envKeys = envelope ? Object.keys(envelope).join('|') : 'none';
		const detail = [
			code ? `code ${code}` : '',
			msg ? `msg ${msg}` : '',
			`ret ${ret}`,
			`v2 keys [${v2Keys.slice(0, 40)}]`,
			`env keys [${envKeys.slice(0, 60)}]`,
		].filter(Boolean).join('; ');
		// A SUCCESS envelope with no data = the account has no Token Plan
		// subscription (PAYG-only). That is a normal state, not a failure.
		const succeeded = /^succ/i.test(ret) || /^succ/i.test(code);
		throw new ProviderHttpError(succeeded ? 'noPlan' : 'unavailable', 0, `Qwen usage payload contains no windows — ${detail}`.slice(0, 190));
	}
	const used5 = percentPointsFromRatioOrValue(usage['per5HourPercentage'] ?? usage['per5hourpercentage']);
	const usedWeek = percentPointsFromRatioOrValue(usage['per1WeekPercentage'] ?? usage['per1weekpercentage']);
	if (used5 === null && usedWeek === null) {
		throw new ProviderHttpError('unavailable', 0, `Qwen usage payload has no window percentages${qwenFailureDetail(body)} (keys: ${Object.keys(usage).slice(0, 14).join('|')})`.slice(0, 190));
	}
	const windows: AccountWindow[] = [];
	const mk = (id: string, label: string, usedPct: number | null, total: number | null, resetKey: string): void => {
		if (usedPct === null) { return; }
		const window: AccountWindow = {
			id,
			label,
			remainingPercent: Math.max(0, Math.min(100, 100 - usedPct)),
		};
		if (total !== null && total > 0) {
			window.used = (total * usedPct) / 100;
			window.limit = total;
		}
		const resetAt = toEpochMs(usage[resetKey]);
		if (resetAt !== undefined) { window.resetAt = resetAt; }
		windows.push(window);
	};
	mk('5h', '5h', used5, quotaTotals.fiveHour, 'per5HourResetTime');
	mk('week', '周', usedWeek, quotaTotals.weekly, 'per1WeekResetTime');

	const planName = specCode ? `Token Plan ${specCode}` : 'Token Plan';
	return { planName, windows };
}

// ─── Fetch pipeline ─────────────────────────────────────────────────────────

function gatewayUrl(cfg: QwenRegionConfig, api: string): string {
	const params = new URLSearchParams({
		product: 'sfm_bailian',
		action: cfg.action,
		api,
		_v: 'undefined',
	});
	return `${cfg.quotaHost}/data/api.json?${params.toString()}`;
}

function gatewayBody(cfg: QwenRegionConfig, cookie: string, api: string, secToken: string, data: Record<string, unknown>, randomUUID: () => string): string {
	const cornerstone: Record<string, unknown> = {
		feTraceId: randomUUID().toLowerCase(),
		protocol: 'V2',
		console: 'ONE_CONSOLE',
		productCode: 'p_efm',
		switchUserType: 3,
		domain: cfg.domain,
		consoleSite: cfg.consoleSite,
		userNickName: '',
		userPrincipalName: '',
		xsp_lang: 'en-US',
	};
	const cna = /(?:^|;\s*)cna=([^;]+)/.exec(cookie);
	if (cna) { cornerstone['X-Anonymous-Id'] = cna[1]; }
	const params: Record<string, unknown> = {
		Api: api,
		V: '1.0',
		Data: { ...data, cornerstoneParam: cornerstone },
	};
	const form = new URLSearchParams({
		product: 'sfm_bailian',
		action: cfg.action,
		region: cfg.region,
		language: 'en-US',
		params: JSON.stringify(params),
	});
	if (secToken) { form.set('sec_token', secToken); }
	return form.toString();
}

async function gatewayCall(cfg: QwenRegionConfig, cookie: string, secToken: string, api: string, data: Record<string, unknown>, options: ProviderFetchOptions, mandatory: boolean): Promise<unknown | null> {
	const randomUUIDImpl = options.randomUUID ?? randomUUID;
	try {
		const { text } = await httpText(gatewayUrl(cfg, api), {
			method: 'POST',
			headers: {
				Cookie: cookie,
				Accept: 'application/json, text/plain, */*',
				'Content-Type': 'application/x-www-form-urlencoded',
				Origin: cfg.infoHost,
				Referer: `${cfg.infoHost}/`,
				'X-Requested-With': 'XMLHttpRequest',
			},
			body: gatewayBody(cfg, cookie, api, secToken, data, randomUUIDImpl),
			fetchImpl: options.fetchImpl,
			timeoutMs: options.timeoutMs,
		});
		const payload = expandEmbeddedJson(parseJson<unknown>(text));
		const failure = findFailure(payload);
		if (failure) {
			const message = String(failure.message ?? failure.msg ?? failure.code ?? 'request was not successful');
			if (looksLikeLoginFailure(JSON.stringify(failure)) || looksLikeLoginFailure(String(failure.code ?? ''))) {
				throw new ProviderHttpError('unauthorized', 401, 'Qwen console session is signed out');
			}
			throw new ProviderHttpError('unavailable', 0, message);
		}
		return payload;
	} catch (err) {
		if (mandatory) { throw err; }
		return null;
	}
}

function findFailure(payload: unknown): Record<string, unknown> | null {
	if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
		const record = payload as Record<string, unknown>;
		if (record.successResponse === false || record.success === false) { return record; }
		for (const nested of Object.values(record)) {
			const found = findFailure(nested);
			if (found) { return found; }
		}
	}
	if (Array.isArray(payload)) {
		for (const item of payload) {
			const found = findFailure(item);
			if (found) { return found; }
		}
	}
	return null;
}

async function fetchQwenPlanSnapshot(cookieRaw: string, options: ProviderFetchOptions): Promise<AccountSnapshot> {
	const fetchedAt = options.now ?? Date.now();
	const cookie = normalizeQwenCookie(cookieRaw);
	const cfg = qwenRegionConfig(options.region);
	const headers = {
		Cookie: cookie,
		Accept: 'application/json, text/plain, */*',
		Referer: `${cfg.infoHost}/`,
	};

	// 1) login state + sec_token
	const info = await httpText(`${cfg.infoHost}/tool/user/info.json`, {
		headers,
		fetchImpl: options.fetchImpl,
		timeoutMs: options.timeoutMs,
	});
	let secToken = '';
	try {
		secToken = parseQwenUserInfo(info.text);
	} catch (err) {
		if (err instanceof ProviderHttpError && err.kind === 'unauthorized') { throw err; }
		// non-JSON shell → treat as signed out only when it looks like a login page
		if (info.text.includes('<html') && /login|sign ?in/i.test(info.text)) {
			throw new ProviderHttpError('unauthorized', 401, 'Qwen console session is signed out');
		}
		secToken = '';
	}
	if (!secToken) {
		const fromCookie = /(?:^|;\s*)sec_token=([^;]+)/.exec(cookie);
		if (fromCookie) { secToken = fromCookie[1]; }
	}

	// 2) subscription (specCode) — best effort for the plan label
	const subscription = await gatewayCall(cfg, cookie, secToken, 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription', { commodityCode: cfg.commodityCode }, options, false);
	const subFrame = subscription ? findObjectWithAnyKey(subscription, ['specCode', 'spec_code']) : null;
	const specCode = subFrame ? String(subFrame.specCode ?? subFrame.spec_code ?? '').trim() : '';

	// 3) quota-config (per-plan totals) — best effort
	const quotaConfig = await gatewayCall(cfg, cookie, secToken, 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/quota-config', { commodityCode: cfg.commodityCode }, options, false);
	let fiveHourTotal: number | null = null;
	let weeklyTotal: number | null = null;
	if (quotaConfig && specCode) {
		const planFrame = findObjectWithAnyKey(quotaConfig, [specCode]);
		if (planFrame) {
			const quota = planFrame[specCode] ?? planFrame[specCode.toLowerCase()];
			if (quota && typeof quota === 'object') {
				fiveHourTotal = toNumber((quota as Record<string, unknown>).five_hour ?? (quota as Record<string, unknown>).fiveHour);
				weeklyTotal = toNumber((quota as Record<string, unknown>).weekly);
			}
		}
	}

	// 4) usage — the mandatory call
	const usage = await gatewayCall(cfg, cookie, secToken, 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage', { commodityCode: cfg.commodityCode }, options, true);
	if (!usage) {
		throw new ProviderHttpError('unavailable', 0, 'Qwen usage request failed');
	}
	const parsed = parseQwenUsage(JSON.stringify(usage), specCode || null, { fiveHour: fiveHourTotal, weekly: weeklyTotal });

	return {
		provider: 'qwen',
		billingMode: 'plan',
		plan: { name: parsed.planName },
		windows: parsed.windows,
		source: 'official-console',
		fetchedAt,
	};
}

function aliyunBalanceForQwen(options: ProviderFetchOptions) {
	return fetchAliyunBalance(options.aliyunAccessKey!, {
		fetchImpl: options.fetchImpl,
		timeoutMs: options.timeoutMs,
		now: () => options.now ?? Date.now(),
		randomUUID: options.randomUUID,
	});
}

/**
 * Plan quota first. With an Aliyun RAM key attached the account balance is
 * added to the plan snapshot; for a PAYG-only account (plan answers `noPlan`)
 * the balance alone becomes the snapshot.
 */
export async function fetchQwenSnapshot(cookieRaw: string, options: ProviderFetchOptions): Promise<AccountSnapshot> {
	try {
		const snapshot = await fetchQwenPlanSnapshot(cookieRaw, options);
		if (options.aliyunAccessKey) {
			const balance = await aliyunBalanceForQwen(options);
			snapshot.balance = { value: balance.available, currency: balance.currency };
		}
		return snapshot;
	} catch (err) {
		if ((err as { kind?: string }).kind !== 'noPlan' || !options.aliyunAccessKey) { throw err; }
		const balance = await aliyunBalanceForQwen(options);
		return {
			provider: 'qwen',
			billingMode: 'payg',
			balance: { value: balance.available, currency: balance.currency },
			windows: [],
			source: 'official-api',
			fetchedAt: options.now ?? Date.now(),
		};
	}
}

/**
 * Lightweight session check used by BrowserLoginService's `verify` hook: does
 * this cookie header produce a non-login answer from user/info.json?
 */
export async function verifyQwenCookie(cookieRaw: string, options: ProviderFetchOptions): Promise<boolean> {
	const cfg = qwenRegionConfig(options.region);
	try {
		const info = await httpText(`${cfg.infoHost}/tool/user/info.json`, {
			headers: {
				Cookie: normalizeQwenCookie(cookieRaw),
				Accept: 'application/json, text/plain, */*',
				Referer: `${cfg.infoHost}/`,
			},
			fetchImpl: options.fetchImpl,
			timeoutMs: options.timeoutMs ?? 10000,
		});
		parseQwenUserInfo(info.text);
		return true;
	} catch {
		return false;
	}
}
