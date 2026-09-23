/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Aliyun BSS OpenAPI — account balance (Qwen/百炼 spends the Alibaba Cloud
 * account balance, which is only reachable through the signed BSS RPC API).
 *
 * Zero-dependency implementation of the POP RPC signature (HMAC-SHA1) using
 * Node's built-in `crypto`. Credentials are the user's RAM AccessKey ID/Secret
 * and live ONLY in VS Code SecretStorage — same policy as every other account
 * credential.
 *
 * Verified against the live endpoint with a fake key: the service answers
 * `InvalidAccessKeyId.NotFound` (i.e. the signature/version/endpoint are
 * correct — a wrong signature would answer `SignatureDoesNotMatch`).
 */

import { createHmac, randomUUID } from 'crypto';
import { classifyStatus, defaultFetchImpl, parseJson, ProviderHttpError, type FetchLike } from './http';
import { toNumber } from './providers/normalize';

export interface AliyunAccessKey {
	id: string;
	secret: string;
}

/** Persisted form of the key pair (single SecretStorage value). */
export function serializeAliyunAccessKey(ak: AliyunAccessKey): string {
	return JSON.stringify({ id: ak.id.trim(), secret: ak.secret.trim() });
}

export function parseAliyunAccessKey(raw: string | undefined): AliyunAccessKey | null {
	if (!raw) { return null; }
	try {
		const parsed = JSON.parse(raw) as { id?: unknown; secret?: unknown };
		if (typeof parsed.id === 'string' && typeof parsed.secret === 'string' && parsed.id.trim() && parsed.secret.trim()) {
			return { id: parsed.id.trim(), secret: parsed.secret.trim() };
		}
	} catch { /* fall through */ }
	return null;
}

const BSS_ENDPOINT = 'https://business.aliyuncs.com/';
const BSS_VERSION = '2017-12-14';
const BSS_ACTION = 'QueryAccountBalance';

/** POP percent-encoding (RFC 3986): like encodeURIComponent plus `~` and `%20`. */
export function percentEncode(value: string): string {
	return encodeURIComponent(value)
		.replace(/\+/g, '%20')
		.replace(/\*/g, '%2A')
		.replace(/%7E/gi, '~');
}

export function buildBssParams(accessKeyId: string, timestampIso: string, nonce: string): Record<string, string> {
	return {
		AccessKeyId: accessKeyId,
		Action: BSS_ACTION,
		Format: 'JSON',
		SignatureMethod: 'HMAC-SHA1',
		SignatureNonce: nonce,
		SignatureVersion: '1.0',
		Timestamp: timestampIso,
		Version: BSS_VERSION,
	};
}

/** POP RPC signature: Base64(HMAC-SHA1(secret + '&', `GET&%2F&` + canonicalQuery)). */
export function signBssParams(params: Record<string, string>, accessKeySecret: string, method = 'GET'): string {
	const canonical = Object.keys(params)
		.sort()
		.map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
		.join('&');
	const stringToSign = `${method}&${percentEncode('/')}&${percentEncode(canonical)}`;
	return createHmac('sha1', `${accessKeySecret}&`).update(stringToSign).digest('base64');
}

export function bssRequestUrl(params: Record<string, string>, signature: string): string {
	const query = Object.keys(params)
		.sort()
		.map(key => `${percentEncode(key)}=${percentEncode(params[key])}`)
		.join('&');
	return `${BSS_ENDPOINT}?${query}&Signature=${percentEncode(signature)}`;
}

export interface AliyunBalance {
	/** Available amount (cash + credit), account currency. */
	available: number;
	currency: string;
}

export function parseAliyunBalance(text: string): AliyunBalance {
	const body = parseJson<{ Code?: unknown; Message?: unknown; Data?: Record<string, unknown> }>(text);
	const data = body.Data ?? {};
	const available = toNumber(data.AvailableAmount ?? data.availableAmount);
	// Data first: Aliyun success responses also carry `Code: "200"` /
	// `Message: "success"`, so the presence of AvailableAmount is the
	// authoritative success signal.
	if (available !== null) {
		const currency = typeof data.Currency === 'string' && data.Currency ? data.Currency : 'CNY';
		return { available, currency };
	}
	const code = body.Code === undefined || body.Code === null ? '' : String(body.Code);
	if (code && code !== '200' && !/^success$/i.test(code)) {
		const message = String(body.Message ?? code);
		const kind = /invalidaccesskey|signaturedoesnotmatch|forbidden|denied|nopermission/i.test(code)
			? 'unauthorized'
			: /throttl|limitexceeded/i.test(code)
				? 'rateLimited'
				: 'unavailable';
		throw new ProviderHttpError(kind, 0, `Aliyun BSS error: ${code} — ${message}`.slice(0, 190));
	}
	throw new ProviderHttpError('unavailable', 0, 'Aliyun balance response is missing AvailableAmount');
}

export interface AliyunFetchOptions {
	fetchImpl?: FetchLike;
	timeoutMs?: number;
	now?: () => number;
	randomUUID?: () => string;
}

/** Query the Alibaba Cloud account balance via BSS OpenAPI. */
export async function fetchAliyunBalance(ak: AliyunAccessKey, options: AliyunFetchOptions = {}): Promise<AliyunBalance> {
	const fetchImpl = options.fetchImpl ?? defaultFetchImpl();
	const timeoutMs = options.timeoutMs ?? 15000;
	const timestamp = new Date(options.now?.() ?? Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z');
	const nonce = (options.randomUUID ?? randomUUID)().replace(/-/g, '');
	const params = buildBssParams(ak.id.trim(), timestamp, nonce);
	const url = bssRequestUrl(params, signBssParams(params, ak.secret.trim()));

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
		const text = await response.text();
		if (!response.ok) {
			// POP returns a JSON error body even on 4xx — prefer its Code.
			try {
				return parseAliyunBalance(text);
			} catch (err) {
				if (err instanceof ProviderHttpError && err.kind !== 'unavailable') { throw err; }
				if (err instanceof ProviderHttpError && /Aliyun BSS error/.test(err.message)) { throw err; }
				throw new ProviderHttpError(classifyStatus(response.status), response.status, `HTTP ${response.status}`);
			}
		}
		return parseAliyunBalance(text);
	} catch (err) {
		if (err instanceof ProviderHttpError) { throw err; }
		if ((err as { name?: string })?.name === 'AbortError') {
			throw new ProviderHttpError('unavailable', 0, `Aliyun balance request timed out after ${timeoutMs}ms`);
		}
		throw new ProviderHttpError('unavailable', 0, err instanceof Error ? err.message : String(err));
	} finally {
		clearTimeout(timer);
	}
}
