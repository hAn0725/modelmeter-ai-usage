/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider adapter tests — all four official quota/balance sources are
 * exercised with scripted HTTP fixtures (never real accounts):
 *   DeepSeek (balance API), GLM (quota/limit), Qwen (ONE_CONSOLE gateway,
 *   nested DataV2 payloads), MiMo (balance + tokenPlan usage).
 */

import { describe, it, expect } from 'vitest';
import { bodyRoute, jsonRoute, scriptedFetch } from './accountTestUtils';
import { ProviderHttpError } from '../accountUsage/http';
import { parseDeepSeekBalance, fetchDeepSeekSnapshot } from '../accountUsage/providers/deepseek';
import { glmWindowMinutes, parseGlmQuota, parseGlmBalance, fetchGlmSnapshot } from '../accountUsage/providers/glm';
import { parseQwenUserInfo, parseQwenUsage, fetchQwenSnapshot, verifyQwenCookie, qwenRegionConfig } from '../accountUsage/providers/qwen';
import { parseMimoBalance, parseMimoUsage, fetchMimoSnapshot } from '../accountUsage/providers/mimo';

const NOW = 1_750_000_000_000;

describe('DeepSeek 适配器（按量余额）', () => {
	it('解析余额行：总额 + 赠金/充值拆分 + CNY 货币', () => {
		const snap = parseDeepSeekBalance(JSON.stringify({
			balance_infos: [{ currency: 'CNY', total_balance: '38.62', granted_balance: '5.00', topped_up_balance: '33.62' }],
		}), NOW);
		expect(snap.provider).toBe('deepseek');
		expect(snap.billingMode).toBe('payg');
		expect(snap.balance).toEqual({ value: 38.62, currency: 'CNY', breakdown: { granted: 5, toppedUp: 33.62 } });
		expect(snap.windows).toEqual([]);
		expect(snap.source).toBe('official-api');
	});

	it('多币种多行时选择有余额的行；零余额也合法', () => {
		const multi = parseDeepSeekBalance(JSON.stringify({
			balance_infos: [
				{ currency: 'USD', total_balance: '0' },
				{ currency: 'CNY', total_balance: '12.5' },
			],
		}), NOW);
		expect(multi.balance?.value).toBe(12.5);
		expect(multi.balance?.currency).toBe('CNY');

		const zero = parseDeepSeekBalance(JSON.stringify({ balance_infos: [{ currency: 'CNY', total_balance: '0' }] }), NOW);
		expect(zero.balance?.value).toBe(0);
	});

	it('空 balance_infos / 缺失 total_balance 抛错；401 → unauthorized；429 → rateLimited', async () => {
		expect(() => parseDeepSeekBalance(JSON.stringify({ balance_infos: [] }), NOW)).toThrow();
		expect(() => parseDeepSeekBalance(JSON.stringify({ balance_infos: [{ currency: 'CNY' }] }), NOW)).toThrow();

		const { fetchImpl, calls } = scriptedFetch([jsonRoute('/user/balance', { error: 'auth' }, 401)]);
		await expect(fetchDeepSeekSnapshot('sk-test', { fetchImpl, now: NOW })).rejects.toMatchObject({ kind: 'unauthorized' });
		expect(calls[0].headers.Authorization).toBe('Bearer sk-test');

		const limited = scriptedFetch([jsonRoute('/user/balance', { error: 'slow down' }, 429)]);
		await expect(fetchDeepSeekSnapshot('sk-test', { fetchImpl: limited.fetchImpl })).rejects.toMatchObject({ kind: 'rateLimited' });
	});
});

describe('GLM / Z.ai 适配器（Coding Plan）', () => {
	const limitsFixture = {
		code: 200,
		data: {
			planName: 'GLM Coding Max',
			limits: [
				{ type: 'TOKENS_LIMIT', percentage: 32, unit: 3, number: 5, nextResetTime: NOW + 3600_000 },
				{ type: 'TOKENS_LIMIT', percentage: 53, unit: 6, number: 1, nextResetTime: NOW + 86400_000 },
				{ type: 'TIME_LIMIT', percentage: 12, unit: 1, number: 30 },
			],
		},
	};

	it('unit 解码：分钟/小时/天/周', () => {
		expect(glmWindowMinutes(5, 45)).toBe(45);
		expect(glmWindowMinutes(3, 2)).toBe(120);
		expect(glmWindowMinutes(1, 2)).toBe(2880);
		expect(glmWindowMinutes(6, 1)).toBe(10080);
		expect(glmWindowMinutes(9, 1)).toBeNull();
		expect(glmWindowMinutes(3, 0)).toBeNull();
	});

	it('窗口排序成 5h + 周 + MCP（月），百分比转为“剩余”', () => {
		const snap = parseGlmQuota(JSON.stringify(limitsFixture), NOW);
		expect(snap.provider).toBe('glm');
		expect(snap.billingMode).toBe('plan');
		expect(snap.plan?.name).toBe('GLM Coding Max');
		expect(snap.windows.map(w => w.id)).toEqual(['5h', 'week', 'mcp']);
		expect(snap.windows[0].remainingPercent).toBe(68);
		expect(snap.windows[1].remainingPercent).toBe(47);
		expect(snap.windows[2].remainingPercent).toBe(88);
		expect(snap.windows[0].resetAt).toBe(NOW + 3600_000);
	});

	it('usage/remaining 可换算精确已用；单个短窗口 → 5h', () => {
		const snap = parseGlmQuota(JSON.stringify({
			code: 200,
			data: { limits: [{ type: 'CREDIT_LIMIT', usage: 100, remaining: 25, unit: 5, number: 300 }] },
		}), NOW);
		expect(snap.windows).toHaveLength(1);
		expect(snap.windows[0].id).toBe('5h');
		expect(snap.windows[0].remainingPercent).toBe(25);
		expect(snap.plan?.name).toBe('Coding Plan'); // fallback 名称
	});

	it('unit=6 的单个窗口不冒充 5h；业务 code 401 → unauthorized；调用使用区域主机', async () => {
		const single = parseGlmQuota(JSON.stringify({
			code: 200,
			data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 40, unit: 6, number: 1 }] },
		}), NOW);
		expect(single.windows[0].id).toBe('plan');
		expect(single.windows[0].remainingPercent).toBe(60);

		const { fetchImpl } = scriptedFetch([jsonRoute('/api/monitor/usage/quota/limit', { code: 401, msg: 'invalid token' })]);
		await expect(fetchGlmSnapshot('k', { fetchImpl })).rejects.toMatchObject({ kind: 'unauthorized' });

		const cn = scriptedFetch([jsonRoute('open.bigmodel.cn', limitsFixture)]);
		await fetchGlmSnapshot('k', { fetchImpl: cn.fetchImpl, region: 'cn', now: NOW });
		expect(cn.calls[0].url.startsWith('https://open.bigmodel.cn/')).toBe(true);
		expect(cn.calls[0].headers.Authorization).toBe('Bearer k');

		const global = scriptedFetch([jsonRoute('api.z.ai', limitsFixture)]);
		await fetchGlmSnapshot('k', { fetchImpl: global.fetchImpl, region: 'global', now: NOW });
		expect(global.calls[0].url.startsWith('https://api.z.ai/')).toBe(true);
	});

	it('parseGlmBalance：成功解析（字符串金额）与缺失字段报错', () => {
		const snap = parseGlmBalance(JSON.stringify({ success: true, data: { availableBalance: '12.5', rechargeAmount: '100', totalSpendAmount: '87.5', frozenBalance: '1' } }), NOW);
		expect(snap.billingMode).toBe('payg');
		expect(snap.balance).toEqual({ value: 12.5, currency: 'CNY' });
		expect(snap.windows).toEqual([]);
		expect(() => parseGlmBalance(JSON.stringify({ success: true, data: {} }), NOW)).toThrow(/availableBalance/);
		try {
			parseGlmBalance(JSON.stringify({ code: 401, msg: '令牌已过期认证不正确', success: false }), NOW);
			expect.unreachable();
		} catch (err) {
			expect((err as { kind?: string }).kind).toBe('unauthorized');
		}
	});

	it('PAYG 账号（cn）：套餐接口判 noPlan 后自动回退查询预付余额', async () => {
		const { fetchImpl, calls } = scriptedFetch([
			jsonRoute('/api/monitor/usage/quota/limit', { code: 500, msg: '当前用户不存在coding plan' }),
			jsonRoute('query-customer-account-report', { success: true, data: { availableBalance: '38.62', rechargeAmount: '100.00', totalSpendAmount: '61.38', frozenBalance: '0' } }),
		]);
		const snap = await fetchGlmSnapshot('k', { fetchImpl, region: 'cn', now: NOW });
		expect(snap.billingMode).toBe('payg');
		expect(snap.balance).toEqual({ value: 38.62, currency: 'CNY' });
		expect(snap.source).toBe('official-api');
		expect(calls).toHaveLength(2);
		expect(calls[1].url).toContain('query-customer-account-report');
		expect(calls[1].headers.Authorization).toBe('Bearer k');
	});

	it('余额接口业务 401 → 保持 noPlan；global 区域不做余额回退', async () => {
		const rejected = scriptedFetch([
			jsonRoute('/api/monitor/usage/quota/limit', { code: 500, msg: '当前用户不存在coding plan' }),
			jsonRoute('query-customer-account-report', { code: 401, msg: '令牌已过期认证不正确', success: false }),
		]);
		await expect(fetchGlmSnapshot('k', { fetchImpl: rejected.fetchImpl, region: 'cn' })).rejects.toMatchObject({ kind: 'noPlan' });

		const globalOnly = scriptedFetch([
			jsonRoute('/api/monitor/usage/quota/limit', { code: 500, msg: '当前用户不存在coding plan' }),
		]);
		await expect(fetchGlmSnapshot('k', { fetchImpl: globalOnly.fetchImpl, region: 'global' })).rejects.toMatchObject({ kind: 'noPlan' });
		expect(globalOnly.calls).toHaveLength(1); // 余额接口仅国内站，不请求
	});

	it('套餐 + 余额并存（cn）：成功附加余额；余额失败静默忽略；global 不查余额', async () => {
		const both = scriptedFetch([
			jsonRoute('/api/monitor/usage/quota/limit', limitsFixture),
			jsonRoute('query-customer-account-report', { success: true, data: { availableBalance: '38.62' } }),
		]);
		const snap = await fetchGlmSnapshot('k', { fetchImpl: both.fetchImpl, region: 'cn', now: NOW });
		expect(snap.billingMode).toBe('plan');
		expect(snap.windows.length).toBeGreaterThan(0); // 套餐窗口
		expect(snap.balance).toEqual({ value: 38.62, currency: 'CNY' }); // 余额并存
		expect(both.calls).toHaveLength(2);

		const brokenBalance = scriptedFetch([
			jsonRoute('/api/monitor/usage/quota/limit', limitsFixture),
			jsonRoute('query-customer-account-report', { message: 'oops' }, 500),
		]);
		const snap2 = await fetchGlmSnapshot('k', { fetchImpl: brokenBalance.fetchImpl, region: 'cn', now: NOW });
		expect(snap2.billingMode).toBe('plan'); // 套餐不受余额失败影响
		expect(snap2.balance).toBeUndefined();

		const globalPlan = scriptedFetch([jsonRoute('api.z.ai', limitsFixture)]);
		const snap3 = await fetchGlmSnapshot('k', { fetchImpl: globalPlan.fetchImpl, region: 'global', now: NOW });
		expect(snap3.billingMode).toBe('plan');
		expect(snap3.balance).toBeUndefined();
		expect(globalPlan.calls).toHaveLength(1); // global 不请求 cn 余额接口
	});

	it('业务码 500 + “不存在 coding plan” 文案 → noPlan（解析层）；其他 500 → unavailable', () => {
		try {
			parseGlmQuota(JSON.stringify({ code: 500, msg: '当前用户不存在coding plan', data: {} }), NOW);
			expect.unreachable();
		} catch (err) {
			expect((err as { kind?: string }).kind).toBe('noPlan');
			expect((err as Error).message).toContain('business code 500');
			expect((err as Error).message).toContain('当前用户不存在coding plan');
		}

		try {
			parseGlmQuota(JSON.stringify({ code: 500, msg: 'internal error' }), NOW);
			expect.unreachable();
		} catch (err) {
			expect((err as { kind?: string }).kind).toBe('unavailable');
			expect((err as Error).message).toContain('internal error');
		}
	});
});

describe('Qwen / 阿里百炼适配器（Token Plan）', () => {
	it('user/info.json：解析 secToken；ConsoleNeedLogin → unauthorized', () => {
		expect(parseQwenUserInfo(JSON.stringify({ code: '200', data: { secToken: 'st-1' } }))).toBe('st-1');
		expect(() => parseQwenUserInfo(JSON.stringify({ code: 'ConsoleNeedLogin', data: {} }))).toThrow();
		try {
			parseQwenUserInfo(JSON.stringify({ code: 'ConsoleNeedLogin' }));
		} catch (err) {
			expect((err as ProviderHttpError).kind).toBe('unauthorized');
		}
	});

	it('usage：0–1 比值 → 剩余百分比，quota 总量换算 used/limit', () => {
		const payload = { successResponse: true, data: { DataV2: JSON.stringify({ per5HourPercentage: 0.32, per1WeekPercentage: 0.53, per5HourResetTime: NOW + 60_000 }) } };
		const parsed = parseQwenUsage(JSON.stringify(payload), 'token-plan-lite', { fiveHour: 1_000_000, weekly: 4_000_000 });
		expect(parsed.planName).toBe('Token Plan token-plan-lite');
		expect(parsed.windows).toHaveLength(2);
		expect(parsed.windows[0].id).toBe('5h');
		expect(parsed.windows[0].remainingPercent).toBe(68);
		expect(parsed.windows[0].used).toBe(320_000);
		expect(parsed.windows[0].limit).toBe(1_000_000);
		expect(parsed.windows[1].remainingPercent).toBe(47);
		expect(parsed.windows[1].limit).toBe(4_000_000);
	});

	it('usage 缺失/登录失效：无窗口且克隆文本含 ConsoleNeedLogin → unauthorized', () => {
		expect(() => parseQwenUsage(JSON.stringify({ successResponse: true, data: {} }), null, { fiveHour: null, weekly: null })).toThrow();
		try {
			parseQwenUsage(JSON.stringify({ data: { code: 'ConsoleNeedLogin' } }), null, { fiveHour: null, weekly: null });
		} catch (err) {
			expect((err as ProviderHttpError).kind).toBe('unauthorized');
		}
	});

	it('业务失败帧（requestId/msg/code）在诊断信息中携带官方 msg；SUCCESS 空数据 → noPlan', () => {
		try {
			parseQwenUsage(JSON.stringify({
				successResponse: true,
				data: { DataV2: JSON.stringify({ ret: 'FAIL', data: { code: 'InvalidParameter', msg: '请先购买 Token Plan', requestId: 'req-1' } }) },
			}), null, { fiveHour: null, weekly: null });
			expect.unreachable();
		} catch (err) {
			expect((err as ProviderHttpError).kind).toBe('unavailable');
			expect((err as Error).message).toContain('请先购买 Token Plan');
			expect((err as Error).message).toContain('code InvalidParameter');
		}

		// 真实百炼按量账号：接口成功但无 Token Plan 数据
		try {
			parseQwenUsage(JSON.stringify({
				successResponse: true,
				data: { DataV2: JSON.stringify({ ret: 'SUCCESS::接口调用成功', data: { msg: 'Success.', code: 'SUCCESS', requestId: 'req-2', success: true } }) },
			}), null, { fiveHour: null, weekly: null });
			expect.unreachable();
		} catch (err) {
			expect((err as ProviderHttpError).kind).toBe('noPlan');
			expect((err as Error).message).toContain('ret SUCCESS');
		}
	});

	it('完整拉取流程（区域默认 intl）：info → subscription → quota-config → usage', async () => {
		const { fetchImpl, calls } = scriptedFetch([
			jsonRoute('/tool/user/info.json', { code: '200', data: { secToken: 'st-9' } }),
			bodyRoute('v2/subscription', { successResponse: true, data: { specCode: 'token-plan-lite' } }),
			bodyRoute('v2/quota-config', { successResponse: true, data: { plans: { 'token-plan-lite': { five_hour: 1_000_000, weekly: 4_000_000 } } } }),
			bodyRoute('v2/usage', { successResponse: true, data: { DataV2: JSON.stringify({ per5HourPercentage: 0.32, per1WeekPercentage: 0.53 }) } }),
		]);
		const snap = await fetchQwenSnapshot('cna=x; login_ticket=y', { fetchImpl, now: NOW });
		expect(snap.provider).toBe('qwen');
		expect(snap.billingMode).toBe('plan');
		expect(snap.plan?.name).toBe('Token Plan token-plan-lite');
		expect(snap.windows.map(w => w.remainingPercent)).toEqual([68, 47]);
		expect(snap.source).toBe('official-console');
		expect(calls).toHaveLength(4);
		// info 请求带 Cookie；网关请求体携带区域信息
		expect(calls[0].headers.Cookie).toContain('login_ticket=y');
		expect(qwenRegionConfig(undefined).region).toBe('ap-southeast-1');
		expect(qwenRegionConfig('cn').region).toBe('cn-beijing');
		// 网关请求中不应出现原始 Cookie 的散装形式
		expect(decodeURIComponent(calls[3].body ?? '')).not.toContain('login_ticket');
	});

	it('强制性 usage 调用失败（ConsoleNeedLogin）→ unauthorized', async () => {
		const { fetchImpl } = scriptedFetch([
			jsonRoute('/tool/user/info.json', { code: '200', data: { secToken: 'st' } }),
			bodyRoute('v2/subscription', { successResponse: false, message: 'nope' }),
			bodyRoute('v2/quota-config', { successResponse: false, message: 'nope' }),
			bodyRoute('v2/usage', { successResponse: false, message: 'ConsoleNeedLogin' }),
		]);
		await expect(fetchQwenSnapshot('cna=x', { fetchImpl })).rejects.toMatchObject({ kind: 'unauthorized' });
	});

	it('verifyQwenCookie：有效 → true，登录失效 → false', async () => {
		const ok = scriptedFetch([jsonRoute('/tool/user/info.json', { code: '200', data: { secToken: 'st' } })]);
		expect(await verifyQwenCookie('a=b', { fetchImpl: ok.fetchImpl })).toBe(true);

		const bad = scriptedFetch([jsonRoute('/tool/user/info.json', { code: 'ConsoleNeedLogin' })]);
		expect(await verifyQwenCookie('a=b', { fetchImpl: bad.fetchImpl })).toBe(false);
	});
});

describe('MiMo / 小米适配器（余额 + Token Plan）', () => {
	it('balance/usage 解析：percent 为 0–1 比值 → 剩余百分比', () => {
		const balance = parseMimoBalance(JSON.stringify({ code: 0, data: { balance: '12.34', cashBalance: '10', giftBalance: '2.34' } }));
		expect(balance).toEqual({ value: 12.34, cash: 10, gift: 2.34 });

		const parsed = parseMimoUsage(JSON.stringify({
			code: 0,
			data: {
				usage: { items: [{ name: 'plan_total_token', used: 300, limit: 1000, percent: 0.3 }] },
				monthUsage: { items: [{ name: 'month_total_token', used: 100, limit: 2000, percent: 0.05 }] },
			},
		}));
		expect(parsed.plan?.remainingPercent).toBe(70);
		expect(parsed.month?.remainingPercent).toBe(95);
	});

	it('端到端：余额必需 + 套餐窗口；余额接口 code!=0 抛错', async () => {
		const { fetchImpl, calls } = scriptedFetch([
			jsonRoute('/api/v1/balance', { code: 0, data: { balance: '12.34' } }),
			jsonRoute('/api/v1/tokenPlan/usage', {
				code: 0,
				data: { usage: { items: [{ name: 'plan_total_token', used: 300, limit: 1000, percent: 0.3 }] } },
			}),
		]);
		const snap = await fetchMimoSnapshot('userId=u; api-platform_slh=s', { fetchImpl, now: NOW });
		expect(snap.billingMode).toBe('plan');
		expect(snap.balance).toEqual({ value: 12.34, currency: 'CNY' });
		expect(snap.windows[0].remainingPercent).toBe(70);
		expect(calls[0].headers.Cookie).toContain('userId=u');
		expect(calls[0].headers.Referer).toContain('platform.xiaomimimo.com');

		const bad = scriptedFetch([jsonRoute('/api/v1/balance', { code: 1, message: 'need login' })]);
		await expect(fetchMimoSnapshot('userId=u', { fetchImpl: bad.fetchImpl })).rejects.toThrow();
	});

	it('PAYG-only 账户：usage 接口报错被容忍（保留余额、无窗口）；2001 登录失效沿错误码传播', async () => {
		const payg = scriptedFetch([
			jsonRoute('/api/v1/balance', { code: 0, data: { balance: '3.5' } }),
			jsonRoute('/api/v1/tokenPlan/usage', { message: 'no plan' }, 500),
		]);
		const snap = await fetchMimoSnapshot('userId=u', { fetchImpl: payg.fetchImpl, now: NOW });
		expect(snap.billingMode).toBe('payg');
		expect(snap.balance?.value).toBe(3.5);
		expect(snap.windows).toEqual([]);

		const signedOut = scriptedFetch([
			jsonRoute('/api/v1/balance', { code: 0, data: { balance: '3.5' } }),
			jsonRoute('/api/v1/tokenPlan/usage', { code: 2001, message: 'needLogin' }),
		]);
		await expect(fetchMimoSnapshot('userId=u', { fetchImpl: signedOut.fetchImpl })).rejects.toMatchObject({ kind: 'unauthorized' });
	});
});
