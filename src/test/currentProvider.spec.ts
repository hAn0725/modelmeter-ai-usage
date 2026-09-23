/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Current-provider identification tests — the mapping that drives BOTH the
 * StatusBar ("which account to show") and the sidebar local totals. The rule
 * is deliberately conservative: anything unrecognized resolves to null and
 * every surface falls back to “ModelMeter” instead of guessing.
 */

import { describe, it, expect } from 'vitest';
import { providerForModel, resolveCurrentProvider, providerVendorMatches } from '../accountUsage/currentProvider';

describe('当前 Provider 识别（模型 → 账户）', () => {
	it('识别各厂商模型 id（大小写不敏感、覆盖常见变体）', () => {
		expect(providerForModel('deepseek-chat')).toBe('deepseek');
		expect(providerForModel('DeepSeek-V4-Pro')).toBe('deepseek');
		expect(providerForModel('mimo-7b')).toBe('mimo');
		expect(providerForModel('xiaomimimo-v2')).toBe('mimo');
		expect(providerForModel('glm-4.6')).toBe('glm');
		expect(providerForModel('zhipu-embedding')).toBe('glm');
		expect(providerForModel('qwen3-max')).toBe('qwen');
		expect(providerForModel('dashscope-qwen')).toBe('qwen');
		expect(providerForModel('tongyi-x')).toBe('qwen');
		expect(providerForModel('bailian-chat')).toBe('qwen');
	});

	it('不猜：未识别模型一律返回 null（Copilot / GPT / Claude / Kimi 等）', () => {
		expect(providerForModel('gpt-5.1')).toBeNull();
		expect(providerForModel('claude-haiku-4.5')).toBeNull();
		expect(providerForModel('o4-mini')).toBeNull();
		expect(providerForModel('kimi-k2')).toBeNull();
		expect(providerForModel('')).toBeNull();
		expect(providerForModel(null)).toBeNull();
		expect(providerForModel(undefined)).toBeNull();
	});

	it('zai 词边界：z.ai / zai 命中，zaier 不误命中', () => {
		expect(providerForModel('z.ai')).toBe('glm');
		expect(providerForModel('zai')).toBe('glm');
		expect(providerForModel('zaier')).toBeNull();
	});

	it('resolveCurrentProvider：最新优先、跳过未识别模型、全部未识别返回 null', () => {
		expect(resolveCurrentProvider(['gpt-5.1', 'deepseek-chat', 'glm-4.6'])).toBe('deepseek');
		expect(resolveCurrentProvider(['qwen3-max', 'deepseek-chat'])).toBe('qwen');
		expect(resolveCurrentProvider(['claude-haiku-4.5', 'kimi-k2'])).toBeNull();
		expect(resolveCurrentProvider([])).toBeNull();
	});

	it('providerVendorMatches：本地数据库 vendor 列 → 账户 provider', () => {
		expect(providerVendorMatches('deepseek', 'deepseek')).toBe(true);
		expect(providerVendorMatches('glm', 'GLM')).toBe(true);
		expect(providerVendorMatches('glm', 'zhipu')).toBe(true);
		expect(providerVendorMatches('qwen', 'Qwen')).toBe(true);
		expect(providerVendorMatches('mimo', 'MiMo')).toBe(true);
		expect(providerVendorMatches('mimo', 'xiaomi')).toBe(true);
		expect(providerVendorMatches('deepseek', 'qwen')).toBe(false);
		expect(providerVendorMatches('qwen', 'deepseek')).toBe(false);
		expect(providerVendorMatches('deepseek', null)).toBe(false);
		expect(providerVendorMatches('deepseek', '')).toBe(false);
	});
});
