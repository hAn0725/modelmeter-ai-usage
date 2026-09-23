/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * AccountUsageService — cache / refresh policy for provider account data.
 *
 * Policy (0.3.0 spec):
 *  - lazy only: nothing is fetched during activation; every fetch is triggered
 *    by ensureFresh() from real events (current-provider change, sidebar open
 *    with stale data, manual refresh, right after connecting)
 *  - TTL: current provider 10 min, other connected providers 30 min
 *  - a failed refresh NEVER clears the last good snapshot; the error is kept
 *    alongside so UIs can render "22 分钟前 · 刷新失败"
 *  - 401/expired → no automatic retries until the user reconnects
 *  - 429 → respects a retry cooldown
 *  - single-flight per provider (StatusBar redraws can never trigger
 *    duplicate HTTP requests)
 *
 * No `vscode` import: the service is fully unit-testable with plain mocks.
 */

import type { AccountErrorKind, AccountProviderId, AccountSnapshot, AccountViewState, CachedAccount } from './types';
import { isSnapshotStale } from './types';
import type { AccountCredentialStore } from './credentialStore';
import { ACCOUNT_PROVIDERS, getProviderDef } from './providerRegistry';
import { sanitizeErrorMessage } from './sanitize';
import { parseAliyunAccessKey } from './aliyunBss';
import type { FetchLike } from './http';
import type { ProviderFetcher } from './fetchers';

export { sanitizeErrorMessage } from './sanitize';

export interface MementoLike {
	get<T>(key: string, defaultValue: T): T;
	update(key: string, value: unknown): Thenable<void>;
}

const CACHE_STATE_KEY = 'modelMeter.account.cache.v1';
const CACHE_REGION_KEY = 'modelMeter.account.region.v1';

const RATE_LIMIT_COOLDOWN_MS = 15 * 60 * 1000;

export interface AccountUsageServiceDeps {
	credentials: AccountCredentialStore;
	memento: MementoLike;
	fetchers: Record<AccountProviderId, ProviderFetcher>;
	/** Which provider the currently observed model belongs to (nullable). */
	resolveCurrentProvider: () => AccountProviderId | null;
	fetchImpl?: FetchLike;
	/** Injectable clock (tests). */
	now?: () => number;
	log?: (message: string) => void;
}

type StoredEntry = {
	snapshot: AccountSnapshot | null;
	updatedAt: number;
	lastError?: { kind: AccountErrorKind; message: string; at: number };
	retryNotBefore?: number;
};

export class AccountUsageService {
	private readonly _entries = new Map<AccountProviderId, StoredEntry>();
	private readonly _connected = new Map<AccountProviderId, boolean>();
	private readonly _regions = new Map<AccountProviderId, string>();
	private readonly _inflight = new Map<AccountProviderId, Promise<void>>();
	private readonly _listeners = new Set<() => void>();

	private readonly _now: () => number;

	constructor(private readonly _deps: AccountUsageServiceDeps) {
		this._now = _deps.now ?? Date.now;
		const stored = _deps.memento.get<Record<string, StoredEntry>>(CACHE_STATE_KEY, {});
		for (const [provider, entry] of Object.entries(stored ?? {})) {
			if (entry && typeof entry === 'object') {
				this._entries.set(provider as AccountProviderId, {
					snapshot: entry.snapshot ?? null,
					updatedAt: entry.updatedAt ?? 0,
					...(entry.lastError ? { lastError: entry.lastError } : {}),
					...(entry.retryNotBefore ? { retryNotBefore: entry.retryNotBefore } : {}),
				});
			}
		}
		const regions = _deps.memento.get<Record<string, string>>(CACHE_REGION_KEY, {});
		for (const [provider, region] of Object.entries(regions ?? {})) {
			if (typeof region === 'string' && region.length > 0) {
				this._regions.set(provider as AccountProviderId, region);
			}
		}
	}

	onDidChange(listener: () => void): { dispose(): void } {
		this._listeners.add(listener);
		return { dispose: () => { this._listeners.delete(listener); } };
	}

	private _fire(): void {
		for (const listener of this._listeners) {
			try { listener(); } catch { /* listener errors never break the service */ }
		}
	}

	private _persist(): void {
		const state: Record<string, StoredEntry> = {};
		for (const [provider, entry] of this._entries) { state[provider] = entry; }
		void this._deps.memento.update(CACHE_STATE_KEY, state);
	}

	private _persistRegions(): void {
		const regions: Record<string, string> = {};
		for (const [provider, region] of this._regions) { regions[provider] = region; }
		void this._deps.memento.update(CACHE_REGION_KEY, regions);
	}

	get(provider: AccountProviderId): AccountViewState {
		return {
			provider,
			connected: this._connected.get(provider) ?? false,
			cached: this._entries.get(provider) ?? null,
			region: this._regions.get(provider),
		};
	}

	getAll(): AccountViewState[] {
		return (Object.keys(this._deps.fetchers) as AccountProviderId[]).map(id => this.get(id));
	}

	region(provider: AccountProviderId): string | undefined {
		return this._regions.get(provider);
	}

	/** The provider behind the currently observed model (delegated resolver). */
	currentProvider(): AccountProviderId | null {
		return this._deps.resolveCurrentProvider();
	}

	/** Refresh the connected-flags from SecretStorage without any network I/O. */
	async refreshConnectedFlags(): Promise<void> {
		let changed = false;
		for (const def of ACCOUNT_PROVIDERS) {
			const kind = def.credential === 'apiKey' ? 'key' : 'cookie';
			const has = Boolean(await this._deps.credentials.get(def.id, kind));
			if ((this._connected.get(def.id) ?? false) !== has) {
				this._connected.set(def.id, has);
				changed = true;
			}
		}
		if (changed) { this._fire(); }
	}

	/** Store a credential and fetch immediately (user just connected). */
	async connect(provider: AccountProviderId, credential: string, region?: string): Promise<void> {
		const def = getProviderDef(provider);
		if (!def) { return; }
		const kind = def.credential === 'apiKey' ? 'key' : 'cookie';
		await this._deps.credentials.set(provider, kind, credential);
		this._connected.set(provider, true);
		if (region) {
			this._regions.set(provider, region);
			this._persistRegions();
		}
		// A fresh credential clears previous auth errors / cooldowns.
		const entry = this._entries.get(provider);
		if (entry) {
			delete entry.lastError;
			delete entry.retryNotBefore;
			this._persist();
		}
		this._deps.log?.(`account ${provider}: credential configured`);
		await this.refresh(provider, { force: true });
	}

	async disconnect(provider: AccountProviderId): Promise<void> {
		const def = getProviderDef(provider);
		if (!def) { return; }
		const kind = def.credential === 'apiKey' ? 'key' : 'cookie';
		await this._deps.credentials.delete(provider, kind);
		this._connected.set(provider, false);
		this._entries.delete(provider);
		this._persist();
		this._deps.log?.(`account ${provider}: credential removed`);
		this._fire();
	}

	/**
	 * Fetch when policy allows it. Returns true when a (possibly cached) usable
	 * state exists afterwards. Never throws.
	 */
	async ensureFresh(provider: AccountProviderId | null, options: { manual?: boolean } = {}): Promise<void> {
		if (!provider) { return; }
		if (!(this._connected.get(provider) ?? false)) { return; }
		if (this._inflight.has(provider)) { await this._inflight.get(provider); return; }
		const entry = this._entries.get(provider);
		const now = this._now();
		const manual = options.manual === true;
		if (entry?.lastError?.kind === 'unauthorized' && !manual) {
			return; // frozen until the user reconnects
		}
		if (entry?.retryNotBefore && now < entry.retryNotBefore && !manual) {
			return; // rate-limit cooldown
		}
		const isCurrent = provider === this._deps.resolveCurrentProvider();
		if (!manual && !isSnapshotStale(entry?.updatedAt ?? 0, now, isCurrent)) {
			return; // fresh enough
		}
		await this.refresh(provider, { force: manual });
	}

	/** Force a fetch now (single-flight). Never throws. */
	refresh(provider: AccountProviderId, options: { force?: boolean } = {}): Promise<void> {
		const existing = this._inflight.get(provider);
		if (existing) { return existing; }
		const task = this._doRefresh(provider).finally(() => {
			this._inflight.delete(provider);
		});
		this._inflight.set(provider, task);
		return task;
	}

	private async _doRefresh(provider: AccountProviderId): Promise<void> {
		const def = getProviderDef(provider);
		if (!def) { return; }
		const kind = def.credential === 'apiKey' ? 'key' : 'cookie';
		const credential = await this._deps.credentials.get(provider, kind);
		const now = this._now();
		if (!credential) {
			this._connected.set(provider, false);
			this._fire();
			return;
		}
		try {
			const fetchOptions: Parameters<ProviderFetcher>[1] = {
				region: this._regions.get(provider),
				now,
				fetchImpl: this._deps.fetchImpl,
			};
			if (provider === 'qwen') {
				// Optional Aliyun RAM key → account-balance fallback for百炼 prepaid.
				const aliyunAk = parseAliyunAccessKey(await this._deps.credentials.get('qwen', 'aliyunAk'));
				if (aliyunAk) { fetchOptions.aliyunAccessKey = aliyunAk; }
			}
			const snapshot = await this._deps.fetchers[provider](credential, fetchOptions);
			const entry: StoredEntry = { snapshot, updatedAt: now };
			this._entries.set(provider, entry);
			this._connected.set(provider, true);
			this._persist();
			this._deps.log?.(`account ${provider}: refreshed (ok)`);
		} catch (err) {
			const errorKind = (err as { kind?: AccountErrorKind }).kind ?? 'unavailable';
			const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
			const entry: StoredEntry = this._entries.get(provider) ?? { snapshot: null, updatedAt: 0 };
			entry.lastError = { kind: errorKind, message, at: now };
			if (errorKind === 'rateLimited') {
				entry.retryNotBefore = now + RATE_LIMIT_COOLDOWN_MS;
			}
			this._entries.set(provider, entry);
			this._persist();
			// The message is sanitized above; structure summaries are diagnostics
			// (field names only) and stay credential-free by construction.
			this._deps.log?.(`account ${provider}: refresh failed (${errorKind}): ${message}`);
		}
		this._fire();
	}
}
