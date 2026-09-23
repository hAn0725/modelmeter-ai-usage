/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Minimal HTTP helper for account providers.
 *
 * - single injectable `FetchLike` (tests never hit the real network)
 * - hard timeout on every request (AbortController)
 * - HTTP status → `ProviderHttpError` with the shared error kinds
 *   (unauthorized / rateLimited / unavailable) so every adapter classifies
 *   failures identically.
 */

import type { AccountErrorKind } from './types';

export interface HttpResponseLike {
	ok: boolean;
	status: number;
	text(): Promise<string>;
	headers?: { get(name: string): string | null };
}

export type FetchLike = (
	url: string,
	init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<HttpResponseLike>;

export class ProviderHttpError extends Error {
	constructor(
		readonly kind: AccountErrorKind,
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = 'ProviderHttpError';
	}
}

export interface HttpRequestOptions {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	/** Hard timeout; default 15s. */
	timeoutMs?: number;
	/** Injectable for tests. */
	fetchImpl?: FetchLike;
}

export interface HttpTextResult {
	status: number;
	text: string;
	headers?: { get(name: string): string | null };
}

export function defaultFetchImpl(): FetchLike {
	const f = (globalThis as { fetch?: unknown }).fetch;
	if (typeof f !== 'function') {
		throw new Error('global fetch is not available in this runtime');
	}
	return f as FetchLike;
}

/** Perform a request and return the text body; throws ProviderHttpError on non-2xx. */
export async function httpText(url: string, options: HttpRequestOptions = {}): Promise<HttpTextResult> {
	const fetchImpl = options.fetchImpl ?? defaultFetchImpl();
	const timeoutMs = options.timeoutMs ?? 15000;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetchImpl(url, {
			method: options.method ?? 'GET',
			headers: options.headers,
			body: options.body,
			signal: controller.signal,
		});
		const text = await response.text();
		if (!response.ok) {
			throw new ProviderHttpError(
				classifyStatus(response.status),
				response.status,
				`HTTP ${response.status}`,
			);
		}
		return { status: response.status, text, headers: response.headers };
	} catch (err) {
		if (err instanceof ProviderHttpError) { throw err; }
		if ((err as { name?: string })?.name === 'AbortError') {
			throw new ProviderHttpError('unavailable', 0, `request timed out after ${timeoutMs}ms`);
		}
		throw new ProviderHttpError('unavailable', 0, err instanceof Error ? err.message : String(err));
	} finally {
		clearTimeout(timer);
	}
}

export function classifyStatus(status: number): AccountErrorKind {
	if (status === 401 || status === 403) { return 'unauthorized'; }
	if (status === 429) { return 'rateLimited'; }
	return 'unavailable';
}

/** Parse JSON text, mapping parse failures to a classified error. */
export function parseJson<T = unknown>(text: string): T {
	try {
		return JSON.parse(text) as T;
	} catch {
		throw new ProviderHttpError('unavailable', 0, 'response was not valid JSON');
	}
}
