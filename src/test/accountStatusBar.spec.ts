/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * StatusBar model tests — text variants (unknown / PAYG / plan) and the
 * markdown tooltip (current account detail, other accounts, local ≈ cost,
 * stale annotations). Everything is pure; no VS Code host required.
 */

import { describe, it, expect } from 'vitest';
import { buildStatusBarText, buildStatusBarTooltip, type StatusBarInput } from '../accountUsage/statusBarModel';
import type { AccountSnapshot } from '../accountUsage/types';

const NOW = 1_750_000_000_000;

function snapshot(partial: Partial<AccountSnapshot> = {}): AccountSnapshot {
	return { provider: 'glm', billingMode: 'plan', windows: [], source: 'official-api', fetchedAt: NOW, ...partial } as AccountSnapshot;
}

function input(partial: Partial<StatusBarInput> = {}): StatusBarInput {
	return {
		providerName: null,
		currentModel: null,
		connected: false,
		snapshot: null,
		lastError: null,
		updatedAt: 0,
		localCostCny: null,
		localTokens: null,
		session: null,
		others: [],
		now: NOW,
		...partial,
	};
}

describe('状态栏文本', () => {
	it('无法识别当前模型 → $(flame) ModelMeter（绝不猜测）', () => {
		expect(buildStatusBarText(input())).toBe('$(flame) ModelMeter');
	});

	it('识别但未连接 → 仅显示 Provider 名', () => {
		expect(buildStatusBarText(input({ providerName: 'GLM' }))).toBe('$(flame) GLM');
	});

	it('按量 → 余额；套餐 → 6 格剩余条；余额缺失的套餐回退名称', () => {
		expect(buildStatusBarText(input({
			providerName: 'DeepSeek', connected: true,
			snapshot: snapshot({ provider: 'deepseek', billingMode: 'payg', balance: { value: 38.62, currency: 'CNY' } }),
		}))).toBe('$(flame) DeepSeek · 余额 ¥38.62');

		expect(buildStatusBarText(input({
			providerName: 'GLM', connected: true,
			snapshot: snapshot({ windows: [{ id: '5h', label: '5h', remainingPercent: 68 }, { id: 'week', label: '周', remainingPercent: 47 }] }),
		}))).toBe('$(flame) GLM · [████░░] 68%');

		expect(buildStatusBarText(input({ providerName: 'MiMo', connected: true, snapshot: snapshot({ provider: 'mimo' }) }))).toBe('$(flame) MiMo');
	});

	it('永远只显示“剩余”百分比（不会出现 32% 已用）', () => {
		const text = buildStatusBarText(input({
			providerName: 'Qwen', connected: true,
			snapshot: snapshot({ provider: 'qwen', windows: [{ id: '5h', label: '5h', remainingPercent: 32 }] }),
		}));
		expect(text).toBe('$(flame) Qwen · [██░░░░] 32%');
	});

	it('完整格式：厂商 · 本轮 tokens · 输出速度 · 等效成本 · 余额', () => {
		const text = buildStatusBarText(input({
			providerName: 'DeepSeek', connected: true,
			snapshot: snapshot({ provider: 'deepseek', billingMode: 'payg', balance: { value: 29.38, currency: 'CNY' } }),
			session: { turns: 14, promptTokens: 45_200, completionTokens: 42_300, totalTokens: 87_500, outputTps: 42.3, costCny: 0.53, unpriced: false },
		}));
		expect(text).toBe('$(flame) DeepSeek · 本轮 87.5K · 42 tok/s · ≈¥0.53 · 余额 ¥29.38');
	});

	it('会话段边界：微额显示 <0.01；全部无价时省略成本；无速度时省略速度', () => {
		const tiny = buildStatusBarText(input({
			providerName: 'GLM', connected: false,
			session: { turns: 1, promptTokens: 800, completionTokens: 200, totalTokens: 1_000, outputTps: null, costCny: 0.003, unpriced: false },
		}));
		expect(tiny).toBe('$(flame) GLM · 本轮 1.0K · ≈¥<0.01');

		const unpriced = buildStatusBarText(input({
			providerName: 'GLM', connected: false,
			session: { turns: 2, promptTokens: 2_000, completionTokens: 2_000, totalTokens: 4_000, outputTps: 12.6, costCny: 0, unpriced: true },
		}));
		expect(unpriced).toBe('$(flame) GLM · 本轮 4.0K · 13 tok/s'); // 无价格 → 省略成本段
	});

	it('套餐 + 余额并存：文本优先显示余额，悬停同时给出窗口与余额', () => {
		const snap = snapshot({
			windows: [{ id: '5h', label: '5h', remainingPercent: 68 }],
			balance: { value: 42.17, currency: 'CNY' },
		});
		expect(buildStatusBarText(input({ providerName: 'GLM', connected: true, snapshot: snap }))).toBe('$(flame) GLM · 余额 ¥42.17');
		const tip = buildStatusBarTooltip(input({ providerName: 'GLM', connected: true, snapshot: snap, updatedAt: NOW }));
		expect(tip).toContain('5h  ['); // 窗口详情行
		expect(tip).toContain('余额 ¥42.17'); // 余额行并存
	});
});

describe('状态栏 tooltip', () => {
	it('未连接：提示配置连接；本地 ≈ 成本不出现', () => {
		const tip = buildStatusBarTooltip(input({ providerName: 'GLM', currentModel: 'glm-4.6' }));
		expect(tip).toContain('当前模型 glm-4.6');
		expect(tip).toContain('GLM 账户未连接');
		expect(tip).toContain('点击配置连接');
		expect(tip).not.toContain('等效 API 成本');
	});

	it('已连接：窗口详情 + 余额 + 本地≈成本（带口径说明）', () => {
		const tip = buildStatusBarTooltip(input({
			providerName: 'DeepSeek', currentModel: 'deepseek-chat', connected: true,
			snapshot: snapshot({ provider: 'deepseek', billingMode: 'payg', balance: { value: 38.62, currency: 'CNY' } }),
			localCostCny: 11.63,
			localTokens: 7_961_574,
			updatedAt: NOW - 22 * 60_000,
		}));
		expect(tip).toContain('DeepSeek · 按量付费');
		expect(tip).toContain('余额 ¥38.62');
		expect(tip).toContain('等效 API 成本（近 7 天）≈ ¥11.63');
		expect(tip).toContain('按官方按量 API 单价换算');
		expect(tip).toContain('不代表套餐实际扣款');
		expect(tip).toContain('更新于 22 分钟前');
	});

	it('tooltip 会话块：轮数/输入输出/输出速度/等效成本/口径句', () => {
		const tip = buildStatusBarTooltip(input({
			providerName: 'DeepSeek', currentModel: 'deepseek-chat', connected: true,
			snapshot: snapshot({ provider: 'deepseek', billingMode: 'payg', balance: { value: 29.38, currency: 'CNY' } }),
			session: { turns: 14, promptTokens: 45_200, completionTokens: 42_300, totalTokens: 87_500, outputTps: 42.3, costCny: 0.53, unpriced: false },
		}));
		expect(tip).toContain('当前会话（本地统计）');
		expect(tip).toContain('14 轮 · 合计 87.5K（输入 45.2K / 输出 42.3K）');
		expect(tip).toContain('输出速度 ≈ 42.3 tok/s');
		expect(tip).toContain('等效 API 成本 ≈ ¥0.53');
		expect(tip).toContain('不代表套餐实际扣款');
	});

	it('tooltip 会话块边界：无价时提示暂无价格；无会话时不出现该块', () => {
		const unpricedTip = buildStatusBarTooltip(input({
			providerName: 'GLM', connected: true,
			session: { turns: 3, promptTokens: 3_000, completionTokens: 1_000, totalTokens: 4_000, outputTps: null, costCny: 0, unpriced: true },
		}));
		expect(unpricedTip).toContain('当前会话（本地统计）');
		expect(unpricedTip).toContain('暂无价格数据');

		const noSession = buildStatusBarTooltip(input({ providerName: 'GLM', connected: true }));
		expect(noSession).not.toContain('当前会话（本地统计）');
	});

	it('其他账户：只列有快照的，显示 6→10 格条；当前账户不重复出现', () => {
		const tip = buildStatusBarTooltip(input({
			providerName: 'GLM', connected: true,
			snapshot: snapshot({ windows: [{ id: '5h', label: '5h', remainingPercent: 68 }] }),
			others: [
				{ name: 'DeepSeek', snapshot: snapshot({ provider: 'deepseek', billingMode: 'payg', balance: { value: 38.62, currency: 'CNY' } }) },
				{ name: 'Qwen', snapshot: null },
				{ name: 'MiMo', snapshot: snapshot({ provider: 'mimo', billingMode: 'payg', balance: { value: 3.5, currency: 'CNY' } }) },
			],
		}));
		expect(tip).toContain('其他账户');
		expect(tip).toContain('DeepSeek   ¥38.62');
		expect(tip).toContain('MiMo   ¥3.50');
		expect(tip).not.toContain('Qwen   ');
	});

	it('刷新失败 / 需要重新连接 / 无套餐（noPlan）的标注', () => {
		const failed = buildStatusBarTooltip(input({
			providerName: 'GLM', connected: true,
			snapshot: snapshot(),
			updatedAt: NOW - 30 * 60_000,
			lastError: { kind: 'unavailable', message: 'GLM quota request answered business code 500 — 服务暂不可用', at: NOW - 5 * 60_000 },
		}));
		expect(failed).toContain('⚠ 刷新失败（5 分钟前）');
		expect(failed).toContain('服务暂不可用'); // 官方原因如实行

		const auth = buildStatusBarTooltip(input({
			providerName: 'GLM', connected: true,
			snapshot: snapshot(),
			updatedAt: NOW - 30 * 60_000,
			lastError: { kind: 'unauthorized', message: 'expired', at: NOW - 5 * 60_000 },
		}));
		expect(auth).toContain('⚠ 需要重新连接（5 分钟前）');

		const noPlan = buildStatusBarTooltip(input({
			providerName: 'Qwen', connected: true,
			snapshot: snapshot({ provider: 'qwen' }),
			updatedAt: NOW - 30 * 60_000,
			lastError: { kind: 'noPlan', message: 'Qwen usage payload contains no windows — ret SUCCESS', at: NOW - 5 * 60_000 },
		}));
		expect(noPlan).toContain('○ 该账号未订阅套餐（按量计费，合法状态）');
		expect(noPlan).not.toContain('⚠'); // 非失败，不显示警告符号
	});

	it('tooltip 绝不含凭据样式文本', () => {
		const tip = buildStatusBarTooltip(input({
			providerName: 'DeepSeek', connected: true,
			snapshot: snapshot({ provider: 'deepseek', billingMode: 'payg', balance: { value: 1, currency: 'CNY' } }),
			lastError: { kind: 'unavailable', message: 'Authorization: Bearer sk-123; cookie=a=b', at: NOW },
		}));
		expect(tip).not.toContain('sk-123');
		expect(tip).not.toContain('cookie=a=b');
	});
});
