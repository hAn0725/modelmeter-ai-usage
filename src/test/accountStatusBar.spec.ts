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
		}))).toBe('$(flame) DeepSeek ¥38.62');

		expect(buildStatusBarText(input({
			providerName: 'GLM', connected: true,
			snapshot: snapshot({ windows: [{ id: '5h', label: '5h', remainingPercent: 68 }, { id: 'week', label: '周', remainingPercent: 47 }] }),
		}))).toBe('$(flame) GLM [████░░] 68%');

		expect(buildStatusBarText(input({ providerName: 'MiMo', connected: true, snapshot: snapshot({ provider: 'mimo' }) }))).toBe('$(flame) MiMo');
	});

	it('永远只显示“剩余”百分比（不会出现 32% 已用）', () => {
		const text = buildStatusBarText(input({
			providerName: 'Qwen', connected: true,
			snapshot: snapshot({ provider: 'qwen', windows: [{ id: '5h', label: '5h', remainingPercent: 32 }] }),
		}));
		expect(text).toBe('$(flame) Qwen [██░░░░] 32%');
	});

	it('套餐 + 余额并存：状态栏显示进度条，悬停同时给出余额', () => {
		const snap = snapshot({
			windows: [{ id: '5h', label: '5h', remainingPercent: 68 }],
			balance: { value: 42.17, currency: 'CNY' },
		});
		expect(buildStatusBarText(input({ providerName: 'GLM', connected: true, snapshot: snap }))).toBe('$(flame) GLM [████░░] 68%');
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
