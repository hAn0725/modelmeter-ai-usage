/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Credential-hygiene tests — the 0.3.0 hard requirement: API keys / cookies /
 * tokens live ONLY in SecretStorage and can never surface in memento caches,
 * error messages or logs. Error sanitization and the credential store are
 * tested directly; the service is tested with captured log output.
 */

import { describe, it, expect } from 'vitest';
import { AccountCredentialStore, secretKey, SECRET_KEY_PREFIX } from '../accountUsage/credentialStore';
import { AccountUsageService, sanitizeErrorMessage } from '../accountUsage/accountUsageService';
import { ACCOUNT_PROVIDERS } from '../accountUsage/providerRegistry';
import type { AccountProviderId } from '../accountUsage/types';
import type { ProviderFetcher } from '../accountUsage/fetchers';
import { makeSecretStorage } from './accountTestUtils';

const SECRET = 'sk-live-9f8e7d6c5b4a';

describe('SecretStorage 凭据存取', () => {
	it('键名使用 modelMeter.account.<provider>.<kind> 前缀', () => {
		expect(SECRET_KEY_PREFIX).toBe('modelMeter.account.');
		expect(secretKey('deepseek', 'key')).toBe('modelMeter.account.deepseek.key');
		expect(secretKey('qwen', 'cookie')).toBe('modelMeter.account.qwen.cookie');
	});

	it('set/get/delete/describe 往返；空白值视为未配置', async () => {
		const secrets = makeSecretStorage();
		const store = new AccountCredentialStore(secrets);

		expect(await store.get('deepseek', 'key')).toBeUndefined();
		await store.set('deepseek', 'key', `  ${SECRET}  `);
		expect(await store.get('deepseek', 'key')).toBe(SECRET); // 修剪后存原文
		expect(await store.describe('deepseek', 'apiKey')).toBe('apiKey');
		expect(await store.describe('glm', 'apiKey')).toBe('none');

		await store.set('glm', 'key', '   ');
		expect(await store.get('glm', 'key')).toBeUndefined();

		await store.delete('deepseek', 'key');
		expect(await store.get('deepseek', 'key')).toBeUndefined();
	});
});

describe('错误文本脱敏（sanitizeErrorMessage）', () => {
	it('Authorization / Cookie / api_key / token / secret 一律替换', () => {
		const cases = [
			'Authorization: Bearer ' + SECRET,
			'Cookie: session=' + SECRET,
			'x-api-key=' + SECRET,
			'api_key: ' + SECRET,
			'token=' + SECRET,
			'client_secret = ' + SECRET,
		];
		for (const raw of cases) {
			const clean = sanitizeErrorMessage(raw);
			expect(clean, raw).not.toContain(SECRET);
			expect(clean, raw).toContain('***');
		}
	});

	it('Bearer/Basic 后跟随的裸 token 也被替换', () => {
		const clean = sanitizeErrorMessage(`request failed: Bearer ${SECRET} (retry later)`);
		expect(clean).not.toContain(SECRET);
		expect(clean).toContain('Bearer ***');
	});

	it('长度截断到 200 字符', () => {
		const long = 'x'.repeat(500);
		expect(sanitizeErrorMessage(long).length).toBe(200);
	});
});

describe('服务层凭据卫生（日志 / memento / lastError）', () => {
	function makeService(failMessage: string): { service: AccountUsageService; logs: string[]; mementoJson: () => string; secrets: Map<string, string> } {
		const secrets = makeSecretStorage();
		const state = new Map<string, unknown>();
		const logs: string[] = [];
		const fetchers = {} as Record<AccountProviderId, ProviderFetcher>;
		for (const def of ACCOUNT_PROVIDERS) {
			fetchers[def.id] = (async () => {
				const err = new Error(failMessage);
				(err as { kind?: string }).kind = 'unavailable';
				throw err;
			}) as ProviderFetcher;
		}
		const service = new AccountUsageService({
			credentials: new AccountCredentialStore(secrets),
			memento: {
				get: <T>(key: string, defaultValue: T): T => (state.has(key) ? state.get(key) as T : defaultValue),
				update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
			},
			fetchers,
			resolveCurrentProvider: () => null,
			log: message => { logs.push(message); },
		});
		return { service, logs, mementoJson: () => JSON.stringify([...state.entries()]), secrets: secrets.values };
	}

	it('失败日志带脱敏原因（不含凭据）；lastError 已脱敏；memento 无凭据', async () => {
		const h = makeService(`HTTP 401 for Cookie: sid=${SECRET}`);
		await h.service.connect('qwen', `sid=${SECRET}; other=1`);
		await new Promise(resolve => setTimeout(resolve, 0));

		for (const line of h.logs) { expect(line).not.toContain(SECRET); }
		const lastError = h.service.get('qwen').cached?.lastError;
		expect(lastError).toBeTruthy();
		expect(lastError!.message).not.toContain(SECRET);
		expect(lastError!.message).toContain('***');

		expect(h.mementoJson()).not.toContain(SECRET);
		expect(h.secrets.get('modelMeter.account.qwen.cookie')).toBe(`sid=${SECRET}; other=1`);
	});

	it('成功路径日志也不含凭据', async () => {
		const state = new Map<string, unknown>();
		const logs: string[] = [];
		const secrets = makeSecretStorage();
		const fetchers = {} as Record<AccountProviderId, ProviderFetcher>;
		for (const def of ACCOUNT_PROVIDERS) {
			fetchers[def.id] = (async () => ({
				provider: def.id,
				billingMode: 'payg' as const,
				balance: { value: 1, currency: 'CNY' },
				windows: [],
				source: 'official-api' as const,
				fetchedAt: Date.now(),
			})) as ProviderFetcher;
		}
		const service = new AccountUsageService({
			credentials: new AccountCredentialStore(secrets),
			memento: {
				get: <T>(key: string, defaultValue: T): T => (state.has(key) ? state.get(key) as T : defaultValue),
				update: async (key: string, value: unknown): Promise<void> => { state.set(key, value); },
			},
			fetchers,
			resolveCurrentProvider: () => null,
			log: message => { logs.push(message); },
		});
		await service.connect('deepseek', SECRET);
		await new Promise(resolve => setTimeout(resolve, 0));
		for (const line of logs) { expect(line).not.toContain(SECRET); }
		expect(JSON.stringify([...state.entries()])).not.toContain(SECRET);
	});
});
