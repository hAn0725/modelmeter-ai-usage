/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * AccountUsageService policy tests — TTL, single-flight, failure semantics,
 * unauthorized freeze, 429 cooldown, connect/disconnect and persistence.
 * All fetchers are fakes; no network I/O.
 */

import { describe, it, expect } from 'vitest';
import { AccountUsageService, type AccountUsageServiceDeps } from '../accountUsage/accountUsageService';
import { AccountCredentialStore } from '../accountUsage/credentialStore';
import { ACCOUNT_PROVIDERS } from '../accountUsage/providerRegistry';
import type { AccountProviderId, AccountSnapshot } from '../accountUsage/types';
import type { ProviderFetcher } from '../accountUsage/fetchers';
import { makeSecretStorage } from './accountTestUtils';

const MIN = 60_000;

interface Harness {
	service: AccountUsageService;
	secrets: ReturnType<typeof makeSecretStorage>;
	mementoState: Map<string, unknown>;
	logs: string[];
	calls: AccountProviderId[];
	advance(ms: number): void;
	setCurrent(provider: AccountProviderId | null): void;
	failWith(kind: string, message?: string, provider?: AccountProviderId): void;
	succeed(): void;
}

function makeHarness(): Harness {
	const secrets = makeSecretStorage();
	const credentials = new AccountCredentialStore(secrets);
	const mementoState = new Map<string, unknown>();
	const memento = {
		get: <T>(key: string, defaultValue: T): T => (mementoState.has(key) ? mementoState.get(key) as T : defaultValue),
		update: async (key: string, value: unknown): Promise<void> => { mementoState.set(key, value); },
	};
	let now = 1_000_000 * MIN;
	let current: AccountProviderId | null = null;
	const logs: string[] = [];
	const calls: AccountProviderId[] = [];
	let failure: { kind: string; message: string } | null = null;
	const perProviderFailures = new Map<AccountProviderId, { kind: string; message: string }>();

	const fetchers = {} as Record<AccountProviderId, ProviderFetcher>;
	for (const def of ACCOUNT_PROVIDERS) {
		fetchers[def.id] = (async (_credential: string, options: { now?: number }) => {
			calls.push(def.id);
			const fail = perProviderFailures.get(def.id) ?? failure;
			if (fail) {
				const err = new Error(fail.message);
				(err as { kind?: string }).kind = fail.kind;
				throw err;
			}
			const snapshot: AccountSnapshot = {
				provider: def.id,
				billingMode: 'payg',
				balance: { value: 10, currency: 'CNY' },
				windows: [],
				source: 'official-api',
				fetchedAt: options.now ?? now,
			};
			return snapshot;
		}) as ProviderFetcher;
	}

	const service = new AccountUsageService({
		credentials,
		memento,
		fetchers,
		resolveCurrentProvider: () => current,
		now: () => now,
		log: (message: string) => { logs.push(message); },
	} as AccountUsageServiceDeps);

	return {
		service, secrets, mementoState, logs, calls,
		advance: (ms: number) => { now += ms; },
		setCurrent: (provider) => { current = provider; },
		failWith: (kind, message = 'boom', provider) => {
			if (provider) { perProviderFailures.set(provider, { kind, message }); }
			else { failure = { kind, message }; }
		},
		succeed: () => { failure = null; perProviderFailures.clear(); },
	};
}

describe('AccountUsageService：惰性 + TTL', () => {
	it('构造时不发请求；连接后才拉取一次；同一 TTL 内重复 ensureFresh 不重复请求', async () => {
		const h = makeHarness();
		expect(h.calls).toEqual([]);

		await h.service.connect('deepseek', 'sk-secret');
		expect(h.calls).toEqual(['deepseek']);
		expect(h.service.get('deepseek').connected).toBe(true);
		expect(h.service.get('deepseek').cached?.snapshot?.provider).toBe('deepseek');

		h.setCurrent('deepseek');
		for (let i = 0; i < 5; i++) { await h.service.ensureFresh('deepseek'); }
		expect(h.calls).toEqual(['deepseek']); // 5 分钟 TTL 内不重复请求

		h.advance(4 * MIN);
		await h.service.ensureFresh('deepseek');
		expect(h.calls).toEqual(['deepseek']); // 4 分钟仍新鲜

		h.advance(2 * MIN); // 累计 6 分钟 > 5 分钟 TTL
		await h.service.ensureFresh('deepseek');
		expect(h.calls).toEqual(['deepseek', 'deepseek']);
	});

	it('当前 Provider TTL 5 分钟 / 其他 15 分钟', async () => {
		const h = makeHarness();
		await h.service.connect('glm', 'key');
		h.setCurrent('deepseek'); // glm 成为“其他”

		h.advance(6 * MIN);
		await h.service.ensureFresh('glm');
		expect(h.calls).toEqual(['glm']); // 其他账户 6 分钟还新鲜（< 15 分钟）

		h.advance(10 * MIN); // 累计 16 分钟 > 15 分钟
		await h.service.ensureFresh('glm');
		expect(h.calls).toEqual(['glm', 'glm']);
	});

	it('未连接的 Provider 不会触网', async () => {
		const h = makeHarness();
		await h.service.ensureFresh('qwen', { manual: true });
		expect(h.calls).toEqual([]);
	});
});

describe('AccountUsageService：失败语义', () => {
	it('刷新失败保留上一次快照，仅附加 lastError', async () => {
		const h = makeHarness();
		await h.service.connect('deepseek', 'sk');
		const before = h.service.get('deepseek').cached?.snapshot;
		const updatedBefore = h.service.get('deepseek').cached?.updatedAt;
		expect(before).toBeTruthy();

		h.failWith('unavailable', 'HTTP 500');
		h.advance(11 * MIN);
		await h.service.ensureFresh('deepseek', { manual: true });
		const state = h.service.get('deepseek').cached!;
		expect(state.snapshot).toEqual(before); // 旧快照保留
		expect(state.lastError?.kind).toBe('unavailable');
		expect(state.updatedAt).toBe(updatedBefore); // updatedAt 不因失败推进
	});

	it('401 → 非手动刷新冻结，手动刷新可重试', async () => {
		const h = makeHarness();
		h.failWith('unauthorized', 'session expired');
		await h.service.connect('qwen', 'cookie');
		expect(h.calls).toEqual(['qwen']);
		h.advance(31 * MIN);

		await h.service.ensureFresh('qwen');
		expect(h.calls).toEqual(['qwen']); // 冻结

		await h.service.ensureFresh('qwen', { manual: true });
		expect(h.calls).toEqual(['qwen', 'qwen']); // 手动可重试
	});

	it('429 → 15 分钟冷却，冷却结束后自动恢复，手动可绕过冷却', async () => {
		const h = makeHarness();
		h.failWith('rateLimited', '429');
		await h.service.connect('glm', 'k');
		expect(h.calls).toEqual(['glm']);

		await h.service.ensureFresh('glm', { manual: true });
		expect(h.calls).toEqual(['glm', 'glm']); // 手动直接请求（仍 429）
		await h.service.ensureFresh('glm');
		expect(h.calls).toEqual(['glm', 'glm']); // 自动冷却中

		h.advance(16 * MIN);
		h.succeed();
		await h.service.ensureFresh('glm');
		expect(h.calls).toEqual(['glm', 'glm', 'glm']);
	});
});

describe('AccountUsageService：并发与生命周期', () => {
	it('单飞：并发 refresh 只触发一次网络请求', async () => {
		const h = makeHarness();
		await h.service.connect('deepseek', 'sk');
		h.advance(60 * MIN);
		const p1 = h.service.refresh('deepseek');
		const p2 = h.service.refresh('deepseek');
		await Promise.all([p1, p2]);
		expect(h.calls).toHaveLength(2); // connect 1 次 + 并发合并 1 次
	});

	it('Provider 隔离：A 持续故障不影响 B/C/D 的刷新与快照', async () => {
		const h = makeHarness();
		h.failWith('unavailable', 'glm down', 'glm');
		await Promise.all([
			h.service.connect('deepseek', 'k'),
			h.service.connect('glm', 'k'),
			h.service.connect('mimo', 'k'),
		]);
		expect(h.service.get('deepseek').cached?.snapshot?.provider).toBe('deepseek');
		expect(h.service.get('mimo').cached?.snapshot?.provider).toBe('mimo');
		expect(h.service.get('glm').connected).toBe(true); // 凭据已存
		expect(h.service.get('glm').cached?.snapshot).toBeNull();
		expect(h.service.get('glm').cached?.lastError?.kind).toBe('unavailable');

		const before = h.service.get('deepseek').cached!.updatedAt;
		h.advance(31 * MIN);
		await Promise.all([
			h.service.ensureFresh('deepseek'),
			h.service.ensureFresh('glm'),
			h.service.ensureFresh('mimo'),
		]);
		expect(h.service.get('deepseek').cached!.updatedAt).toBeGreaterThan(before); // B 照 TTL 正常刷新
		expect(h.service.get('mimo').cached!.snapshot?.provider).toBe('mimo');
		expect(h.service.get('glm').cached?.snapshot).toBeNull(); // A 仍故障，但不影响其他账户
	});

	it('onDidChange 在连接/刷新/断开时触发', async () => {
		const h = makeHarness();
		let fired = 0;
		const sub = h.service.onDidChange(() => { fired++; });
		await h.service.connect('deepseek', 'sk');
		expect(fired).toBeGreaterThanOrEqual(1);
		await h.service.disconnect('deepseek');
		expect(h.service.get('deepseek').connected).toBe(false);
		expect(h.service.get('deepseek').cached).toBeNull();
		sub.dispose();
	});

	it('断开后重复连接清空旧错误；凭据仅存 SecretStorage', async () => {
		const h = makeHarness();
		h.failWith('unauthorized');
		await h.service.connect('deepseek', 'sk-secret-1');
		expect(h.service.get('deepseek').cached?.lastError?.kind).toBe('unauthorized');

		h.succeed();
		await h.service.connect('deepseek', 'sk-secret-2');
		expect(h.service.get('deepseek').cached?.lastError).toBeUndefined();
		expect(h.secrets.values.get('modelMeter.account.deepseek.key')).toBe('sk-secret-2');
		// globalState（非敏感缓存）绝不含密钥
		const serialized = JSON.stringify([...h.mementoState.entries()]);
		expect(serialized).not.toContain('sk-secret');
	});

	it('持久化：新实例从 memento 恢复快照；refreshConnectedFlags 从 SecretStorage 恢复连接标记', async () => {
		const h = makeHarness();
		await h.service.connect('mimo', 'cookie-value');
		await new Promise(resolve => setTimeout(resolve, 0)); // 等待 memento.update 落盘

		const restored = new AccountUsageService({
			credentials: new AccountCredentialStore(h.secrets),
			memento: {
				get: <T>(key: string, defaultValue: T): T => (h.mementoState.has(key) ? h.mementoState.get(key) as T : defaultValue),
				update: async (key: string, value: unknown): Promise<void> => { h.mementoState.set(key, value); },
			},
			fetchers: Object.fromEntries(ACCOUNT_PROVIDERS.map(def => [def.id, async () => { throw new Error('unexpected fetch'); }])),
			resolveCurrentProvider: () => null,
			now: () => 2_000_000 * MIN,
		} as unknown as AccountUsageServiceDeps);

		expect(restored.get('mimo').cached?.snapshot?.provider).toBe('mimo');
		expect(restored.get('mimo').connected).toBe(false); // 连接标记需从 SecretStorage 恢复
		await restored.refreshConnectedFlags();
		expect(restored.get('mimo').connected).toBe(true);
		expect(restored.region('mimo')).toBeUndefined();
	});
});
