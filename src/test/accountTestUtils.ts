/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared test doubles for the 0.3.0 account module. NO test in this suite may
 * perform real network I/O — every provider call goes through `scriptedFetch`.
 */

import type { FetchLike, HttpResponseLike } from '../accountUsage/http';
import type { SecretStorageLike } from '../accountUsage/credentialStore';

export interface FetchCallRecord {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

export interface RouteOutcome {
	status?: number;
	body: string;
}

export interface ScriptedRoute {
	/** Return true when this route handles the request. */
	match: (call: FetchCallRecord) => boolean;
	outcome: RouteOutcome | ((call: FetchCallRecord) => RouteOutcome);
}

export interface ScriptedFetch {
	fetchImpl: FetchLike;
	calls: FetchCallRecord[];
}

export function scriptedFetch(routes: ScriptedRoute[]): ScriptedFetch {
	const calls: FetchCallRecord[] = [];
	const fetchImpl: FetchLike = async (url, init) => {
		const call: FetchCallRecord = {
			url,
			method: init?.method ?? 'GET',
			headers: init?.headers ?? {},
			body: init?.body,
		};
		calls.push(call);
		const route = routes.find(r => r.match(call));
		if (!route) {
			throw new Error(`scriptedFetch: unexpected request ${call.method} ${call.url}`);
		}
		const outcome = typeof route.outcome === 'function' ? route.outcome(call) : route.outcome;
		const status = outcome.status ?? 200;
		const response: HttpResponseLike = {
			ok: status >= 200 && status < 300,
			status,
			text: async () => outcome.body,
		};
		return response;
	};
	return { fetchImpl, calls };
}

/** Route by URL substring; body serialized as JSON. */
export function jsonRoute(urlPart: string, body: unknown, status = 200): ScriptedRoute {
	return {
		match: call => call.url.includes(urlPart),
		outcome: { status, body: JSON.stringify(body) },
	};
}

/** Route by request-body substring (Qwen gateway reuses one URL). */
export function bodyRoute(bodyPart: string, body: unknown, status = 200): ScriptedRoute {
	return {
		// form-encoded bodies escape `/` as %2F — decode before matching
		match: call => safeDecode(call.body).includes(bodyPart),
		outcome: { status, body: JSON.stringify(body) },
	};
}

function safeDecode(value: string | undefined): string {
	if (!value) { return ''; }
	try {
		return decodeURIComponent(value.replace(/\+/g, ' '));
	} catch {
		return value;
	}
}

export function makeSecretStorage(initial: Record<string, string> = {}): SecretStorageLike & { values: Map<string, string> } {
	const values = new Map<string, string>(Object.entries(initial));
	return {
		values,
		get: async (key: string) => values.get(key),
		store: async (key: string, value: string) => { values.set(key, value); },
		delete: async (key: string) => { values.delete(key); },
	};
}
