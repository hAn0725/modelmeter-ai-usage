/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Account view-model tests — progress bars, primary-window selection, compact
 * lines and sidebar rows/details. Everything renders REMAINING percentages.
 */

import { describe, it, expect } from 'vitest';
import {
	formatProgressBar, formatPercent, formatBalance, compactAccountSummary,
	selectPrimaryWindow, selectFiveHourWindow, windowDetailLine, formatRelativeTime,
	DETAIL_CELLS, STATUS_BAR_CELLS,
} from '../accountUsage/windowSelection';
import { accountModeLabel, accountCompactLine, buildAccountRow, buildAccountDetail } from '../accountUsage/accountViewModel';
import { getProviderDef } from '../accountUsage/providerRegistry';
import type { AccountSnapshot, AccountViewState } from '../accountUsage/types';

const NOW = 1_750_000_000_000;

function snapshot(partial: Partial<AccountSnapshot> = {}): AccountSnapshot {
	return {
		provider: 'glm',
		billingMode: 'plan',
		windows: [],
		source: 'official-api',
		fetchedAt: NOW,
		...partial,
	} as AccountSnapshot;
}

describe('进度条与百分比（全部为“剩余”）', () => {
	it('6 格状态栏进度条：0 / 34 / 68 / 100 / NaN', () => {
		expect(formatProgressBar(0, STATUS_BAR_CELLS)).toBe('░░░░░░');
		expect(formatProgressBar(34, STATUS_BAR_CELLS)).toBe('██░░░░');
		expect(formatProgressBar(68, STATUS_BAR_CELLS)).toBe('████░░');
		expect(formatProgressBar(100, STATUS_BAR_CELLS)).toBe('██████');
		expect(formatProgressBar(Number.NaN, STATUS_BAR_CELLS)).toBe('░░░░░░');
		expect(formatProgressBar(-5, STATUS_BAR_CELLS)).toBe('░░░░░░');
		expect(formatProgressBar(120, STATUS_BAR_CELLS)).toBe('██████');
	});

	it('百分比四舍五入并钳制', () => {
		expect(formatPercent(67.6)).toBe('68%');
		expect(formatPercent(-3)).toBe('0%');
		expect(formatPercent(130)).toBe('100%');
	});
});

describe('主窗口选择', () => {
	const pct = (id: string, percent: number | undefined) => ({ id, label: id, remainingPercent: percent });

	it('优先 5h；否则第一个带百分比的窗口；都没有则 undefined', () => {
		const snap = snapshot({ windows: [pct('week', 47), pct('5h', 68)] });
		expect(selectPrimaryWindow(snap)?.id).toBe('5h');
		expect(selectFiveHourWindow(snap)?.remainingPercent).toBe(68);

		const no5h = snapshot({ windows: [pct('plan', 73)] });
		expect(selectPrimaryWindow(no5h)?.id).toBe('plan');
		expect(selectFiveHourWindow(no5h)).toBeUndefined();

		expect(selectPrimaryWindow(snapshot({ windows: [pct('mcp', undefined)] }))).toBeUndefined();
		expect(selectPrimaryWindow(null)).toBeUndefined();
	});
});

describe('紧凑行（状态栏 / 其他账户 / 侧边栏）', () => {
	it('套餐 → 6 格条 + 剩余百分比；按量 → 余额', () => {
		const plan = snapshot({ windows: [{ id: '5h', label: '5h', remainingPercent: 68 }] });
		expect(compactAccountSummary(plan)).toBe('[████░░] 68%');

		const payg = snapshot({ billingMode: 'payg', provider: 'deepseek', windows: [], balance: { value: 38.62, currency: 'CNY' } });
		expect(compactAccountSummary(payg)).toBe('¥38.62');
		expect(formatBalance(payg)).toBe('¥38.62');
		expect(compactAccountSummary(null)).toBeNull();

		const usd = snapshot({ billingMode: 'payg', windows: [], balance: { value: 5, currency: 'USD' } });
		expect(compactAccountSummary(usd)).toBe('USD 5.00');
	});

	it('10 格详情行带重置时间；跨天时带日期', () => {
		const sameDayReset = new Date(2025, 5, 14, 16, 0, 0).getTime();
		const line = windowDetailLine({ id: '5h', label: '5h', remainingPercent: 68, resetAt: sameDayReset }, new Date(2025, 5, 14, 14, 32, 0).getTime());
		expect(line).toBe('5h  [███████░░░] 68% 剩余 · 重置 16:00');

		const nextDay = windowDetailLine({ id: 'week', label: '周', remainingPercent: 47, resetAt: new Date(2025, 5, 15, 8, 0, 0).getTime() }, new Date(2025, 5, 14, 14, 32, 0).getTime());
		expect(nextDay).toContain('重置 6/15 08:00');

		expect(windowDetailLine({ id: 'x', label: '套餐' }, NOW)).toBe('套餐');
		expect(windowDetailLine({ id: 'x', label: 'x', remainingPercent: 10 }, NOW).length).toBeGreaterThan(0);
		// 10 格
		expect(windowDetailLine({ id: 'x', label: 'x', remainingPercent: 100 }, NOW).includes('█'.repeat(DETAIL_CELLS))).toBe(true);
	});

	it('相对时间', () => {
		expect(formatRelativeTime(0, NOW)).toBe('从未更新');
		expect(formatRelativeTime(NOW - 30_000, NOW)).toBe('刚刚');
		expect(formatRelativeTime(NOW - 22 * 60_000, NOW)).toBe('22 分钟前');
		expect(formatRelativeTime(NOW - 3 * 3600_000, NOW)).toBe('3 小时前');
		expect(formatRelativeTime(NOW - 2 * 86400_000, NOW)).toBe('2 天前');
	});
});

describe('侧边栏账户行 / 详情', () => {
	const glmDef = getProviderDef('glm')!;
	const deepseekDef = getProviderDef('deepseek')!;

	function state(partial: Partial<AccountViewState> & { provider: AccountViewState['provider'] }): AccountViewState {
		return { connected: false, cached: null, ...partial };
	}

	it('未连接 → 提示点击连接；连接但无快照 → 按错误分类提示', () => {
		const row = buildAccountRow(glmDef, state({ provider: 'glm' }), false);
		expect(row.mode).toBe('未连接');
		expect(row.line2).toBe('点击连接');

		const authErr = buildAccountRow(glmDef, state({
			provider: 'glm', connected: true,
			cached: { snapshot: null, updatedAt: 0, lastError: { kind: 'unauthorized', message: 'x', at: NOW } },
		}), true);
		expect(authErr.line2).toBe('需要重新连接');

		const netErr = buildAccountRow(glmDef, state({
			provider: 'glm', connected: true,
			cached: { snapshot: null, updatedAt: 0, lastError: { kind: 'unavailable', message: 'x', at: NOW } },
		}), false);
		expect(netErr.line2).toBe('刷新失败 · 点击重试');
	});

	it('GLM 行：Coding Plan + “5h 68% · 周 47%”；DeepSeek：按量 + 余额', () => {
		const glmRow = buildAccountRow(glmDef, state({
			provider: 'glm', connected: true,
			cached: {
				snapshot: snapshot({ windows: [{ id: '5h', label: '5h', remainingPercent: 68 }, { id: 'week', label: '周', remainingPercent: 47 }] }),
				updatedAt: NOW,
			},
		}), true);
		expect(glmRow.mode).toBe('Coding Plan');
		expect(glmRow.line2).toBe('5h 68% · 周 47%');
		expect(glmRow.current).toBe(true);

		const deepseekRow = buildAccountRow(deepseekDef, state({
			provider: 'deepseek', connected: true,
			cached: { snapshot: snapshot({ provider: 'deepseek', billingMode: 'payg', windows: [], balance: { value: 38.62, currency: 'CNY' } }), updatedAt: NOW },
		}), false);
		expect(deepseekRow.mode).toBe('按量');
		expect(deepseekRow.line2).toBe('余额 ¥38.62');
	});

	it('模式标签：Qwen 套餐名 / 未知套餐回退', () => {
		expect(accountModeLabel('qwen', snapshot({ provider: 'qwen', plan: { name: 'Token Plan lite' } }))).toBe('Token Plan lite');
		expect(accountModeLabel('mimo', snapshot({ provider: 'mimo' }))).toBe('套餐');
		expect(accountModeLabel('deepseek', snapshot({ billingMode: 'payg' }))).toBe('按量');
		expect(accountModeLabel('glm', null)).toBe('—');
		expect(accountCompactLine(null)).toBe('');
	});

	it('详情：额度条 + 余额拆分 + 本地（近 7 天）+ 来源 + 更新时间 + stale 提示', () => {
		const view = state({
			provider: 'glm', connected: true,
			cached: {
				snapshot: snapshot({
					windows: [{ id: '5h', label: '5h', remainingPercent: 68 }],
					plan: { name: 'Coding Plan Max' },
					balance: { value: 42.17, currency: 'CNY', breakdown: { granted: 10, toppedUp: 32.17 } },
				}),
				updatedAt: NOW - 22 * 60_000,
				lastError: { kind: 'unavailable', message: 'boom', at: NOW - 60_000 },
			},
		});
		const detail = buildAccountDetail('glm', view, { tokens: 1_500_000, costCny: 12.34 }, NOW)!;
		const map = new Map(detail.rows.map(r => [r.label, r.value]));
		expect(map.get('套餐')).toBe('Coding Plan Max');
		expect(map.get('余额')).toBe('¥42.17（赠金 ¥10.00 · 充值 ¥32.17）');
		expect(map.get('本地 Token（近 7 天）')).toBe('1.50M');
		expect(map.get('等效 API 成本（近 7 天）')).toBe('≈ ¥12.34（按官方按量价换算，不代表套餐扣款）');
		expect(map.get('数据来源')).toBe('官方 API');
		expect(map.get('更新时间')).toBe('22 分钟前');
		expect(detail.rows.some(r => r.label === '额度' && r.value.startsWith('5h  ['))).toBe(true);
		expect(detail.stale).toBe('刷新失败（1 分钟前）');
		expect(detail.rows.find(r => r.label === '最近错误')?.value).toBe('boom'); // 官方原因如实行

		const unauthorized = buildAccountDetail('glm', state({
			provider: 'glm', connected: true,
			cached: { snapshot: snapshot(), updatedAt: NOW - 3600_000, lastError: { kind: 'unauthorized', message: 'x', at: NOW - 60_000 } },
		}), null, NOW)!;
		expect(unauthorized.stale).toBe('需要重新连接（1 分钟前）');

		expect(buildAccountDetail('glm', state({ provider: 'glm' }), null, NOW)).toBeNull();
	});

	it('套餐 + 余额并存：侧边栏行同时展示窗口与余额', () => {
		const row = buildAccountRow(glmDef, state({
			provider: 'glm', connected: true,
			cached: {
				snapshot: snapshot({
					windows: [{ id: '5h', label: '5h', remainingPercent: 68 }, { id: 'week', label: '周', remainingPercent: 47 }],
					balance: { value: 42.17, currency: 'CNY' },
				}),
				updatedAt: NOW,
			},
		}), true);
		expect(row.mode).toBe('Coding Plan');
		expect(row.line2).toBe('5h 68% · 周 47% · 余额 ¥42.17');

		const detail = buildAccountDetail('glm', state({
			provider: 'glm', connected: true,
			cached: {
				snapshot: snapshot({
					windows: [{ id: '5h', label: '5h', remainingPercent: 68 }],
					balance: { value: 42.17, currency: 'CNY' },
				}),
				updatedAt: NOW,
			},
		}), null, NOW)!;
		const map = new Map(detail.rows.map(r => [r.label, r.value]));
		expect(map.get('额度')?.startsWith('5h  [')).toBe(true);
		expect(map.get('余额')).toBe('¥42.17');
	});

	it('按量账号（noPlan）列表行与详情：中性文案而非“刷新失败”', () => {
		const view = state({
			provider: 'qwen', connected: true,
			cached: { snapshot: null, updatedAt: 0, lastError: { kind: 'noPlan', message: 'Qwen usage payload contains no windows — ret SUCCESS', at: NOW } },
		});
		const row = buildAccountRow(getProviderDef('qwen')!, view, true);
		expect(row.mode).toBe('按量');
		expect(row.line2).toBe('按量计费 · 无套餐额度');

		const detail = buildAccountDetail('qwen', view, null, NOW)!;
		expect(detail.stale).toBe('未检测到套餐订阅（刚刚）');
		expect(detail.rows.find(r => r.label === '说明')?.value).toContain('按量计费');
		expect(detail.rows.some(r => r.label === '最近错误')).toBe(false); // 非失败，不显示错误
	});

	it('官方控制台来源显示为“官方控制台”', () => {
		const detail = buildAccountDetail('qwen', state({
			provider: 'qwen', connected: true,
			cached: { snapshot: snapshot({ provider: 'qwen', source: 'official-console' }), updatedAt: NOW },
		}), null, NOW)!;
		expect(detail.rows.find(r => r.label === '数据来源')?.value).toBe('官方控制台');
	});
});
