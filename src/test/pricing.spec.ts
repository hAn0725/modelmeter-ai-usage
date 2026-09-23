/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * 官方 API 原价计费专项测试（DeepSeek 峰谷/节假日/alias/历史生效价格 + 中国区人民币价 + 币种语义）。
 *
 * 官方来源（已核对，2026-09-23）：
 *  - DeepSeek 模型与价格：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *  - 峰谷生效 2026-08-17 00:00：news260813；降价与 V4.1 Flash 上线 2026-09-10 12:00：news260910
 *  - Qwen 华北2（北京）：https://help.aliyun.com/zh/model-studio/qwen3-8-flash （¥0.8/¥2.7）
 *  - 智谱 BigModel：https://docs.bigmodel.cn/cn/guide/start/pricing
 *  - 2026 法定节假日：国办发明电〔2025〕7号 https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 */

import { describe, it, expect, afterEach } from 'vitest';
import { estimateTurnCost, setUsdToCnyRate, combineToCny } from '../tokenUsage/tokenCostEstimator';
import { isDeepseekPeak } from '../tokenUsage/dynamicPricing';
import { isChinaStatutoryHoliday, beijingClockFromUtcMs } from '../tokenUsage/chinaHolidays';

/** 北京时间 2026 年某日 h:mi → UTC 毫秒（UTC+8 固定）。 */
function bj(mo: number, d: number, h: number, mi = 0): number {
	return Date.UTC(2026, mo - 1, d, h - 8, mi);
}

const M = 1_000_000; // 1M tokens

// ─── A–I：DeepSeek 峰谷与法定节假日判定（北京时间） ─────────────────────────

describe('DeepSeek 峰谷判定（北京时间，官方规则）', () => {
	it('A. 普通周一 10:00 → 高峰', () => {
		expect(isDeepseekPeak(bj(9, 14, 10))).toBe(true); // 2026-09-14 周一
	});
	it('B. 普通周一 13:00 → 闲时（午间非高峰）', () => {
		expect(isDeepseekPeak(bj(9, 14, 13))).toBe(false);
	});
	it('C. 普通周一 15:00 → 高峰', () => {
		expect(isDeepseekPeak(bj(9, 14, 15))).toBe(true);
	});
	it('D. 普通周一 22:00 → 闲时', () => {
		expect(isDeepseekPeak(bj(9, 14, 22))).toBe(false);
	});
	it('E. 周六 10:00 → 闲时（周末全天）', () => {
		expect(isDeepseekPeak(bj(9, 19, 10))).toBe(false); // 2026-09-19 周六
	});
	it('F. 周日 15:00 → 闲时（周末全天）', () => {
		expect(isDeepseekPeak(bj(9, 20, 15))).toBe(false); // 2026-09-20 周日
	});
	it('G. 法定节假日落在周五（2026-09-25 中秋）10:00 → 闲时', () => {
		expect(isChinaStatutoryHoliday(2026, 9, 25)).toBe(true);
		expect(isDeepseekPeak(bj(9, 25, 10))).toBe(false);
		expect(isDeepseekPeak(bj(9, 25, 15))).toBe(false);
	});
	it('G2. 国庆长假中的工作日（2026-10-01 周四）→ 闲时', () => {
		expect(isChinaStatutoryHoliday(2026, 10, 1)).toBe(true);
		expect(isDeepseekPeak(bj(10, 1, 10))).toBe(false);
	});
	it('H. 调休补班周日/周六：官方口径“周末全天闲时”，不按工作日处理', () => {
		// 2026-09-20 是国务院公告的调休上班日（补 9-25/27 中秋节假期），且为周日。
		// DeepSeek 官方规则仅有“周一至周五（不含法定节假日）9-12/14-18 为高峰；周末全天闲时”,
		// 未将调休工作日排除在周末定义之外 —— 因此仍按闲时计价。
		expect(isDeepseekPeak(bj(9, 20, 10))).toBe(false);
		expect(isDeepseekPeak(bj(9, 20, 15))).toBe(false);
	});
	it('I. 高峰窗口边界（09:00 进 / 12:00 出 / 14:00 进 / 18:00 出），且按北京时间而非本机时区', () => {
		expect(isDeepseekPeak(bj(9, 15, 8, 59))).toBe(false);
		expect(isDeepseekPeak(bj(9, 15, 9, 0))).toBe(true);
		expect(isDeepseekPeak(bj(9, 15, 11, 59))).toBe(true);
		expect(isDeepseekPeak(bj(9, 15, 12, 0))).toBe(false);
		expect(isDeepseekPeak(bj(9, 15, 13, 59))).toBe(false);
		expect(isDeepseekPeak(bj(9, 15, 14, 0))).toBe(true);
		expect(isDeepseekPeak(bj(9, 15, 17, 59))).toBe(true);
		expect(isDeepseekPeak(bj(9, 15, 18, 0))).toBe(false);
	});
	it('I2. 北京时间换算固定 UTC+8（UTC 周一 01:30 = 北京周一 09:30，与运行环境时区无关）', () => {
		const c = beijingClockFromUtcMs(Date.UTC(2026, 8, 14, 1, 30));
		expect([c.year, c.month, c.day, c.weekday, c.hour, c.minute]).toEqual([2026, 9, 14, 1, 9, 30]);
	});
});

// ─── DeepSeek 逐 Turn 计价 + 历史生效价格 + alias 路由 ──────────────────────

describe('DeepSeek 逐 Turn 官方人民币计价', () => {
	it('V4.1 Flash 高峰：1M 输入(未命中) + 1M 输出 = ¥10（¥2 + ¥8）', () => {
		const est = estimateTurnCost(M, M, 0, 'deepseek-flash', bj(9, 14, 10))!;
		expect(est.currency).toBe('CNY');
		expect(est.total).toBeCloseTo(10, 10);
	});
	it('V4.1 Flash 闲时：1M 输入 + 1M 输出 = ¥5（¥1 + ¥4）', () => {
		const est = estimateTurnCost(M, M, 0, 'deepseek-flash', bj(9, 14, 22))!;
		expect(est.total).toBeCloseTo(5, 10);
	});
	it('同一模型不同时点价格不同：10:00 ¥10 vs 13:00 ¥5（逐 Turn 生效）', () => {
		const peak = estimateTurnCost(M, M, 0, 'deepseek-flash', bj(9, 14, 10))!;
		const off = estimateTurnCost(M, M, 0, 'deepseek-flash', bj(9, 14, 13))!;
		expect(peak.total).toBeCloseTo(10, 10);
		expect(off.total).toBeCloseTo(5, 10);
	});
	it('历史阶段 1（≤2026-08-16，无峰谷）：V4-Flash 1M 输入 + 1M 输出 = ¥3（¥1 + ¥2）', () => {
		const est = estimateTurnCost(M, M, 0, 'deepseek/deepseek-v4-flash', bj(8, 10, 10))!;
		expect(est.total).toBeCloseTo(3, 10);
	});
	it('峰谷生效边界：2026-08-16（周日）¥3 → 2026-08-17（周一 10:00 高峰）¥12（¥3 + ¥9）', () => {
		const before = estimateTurnCost(M, M, 0, 'deepseek-v4-flash', bj(8, 16, 10))!;
		expect(before.total).toBeCloseTo(3, 10);
		const after = estimateTurnCost(M, M, 0, 'deepseek-v4-flash', bj(8, 17, 10))!;
		expect(after.total).toBeCloseTo(12, 10);
	});
	it('历史阶段 2（08-17 ~ 09-10 12:00）：08-20（周四）10:00 高峰 ¥12；13:00 闲时 ¥6', () => {
		const peak = estimateTurnCost(M, M, 0, 'deepseek/deepseek-v4-flash', bj(8, 20, 10))!;
		expect(peak.total).toBeCloseTo(12, 10);
		const off = estimateTurnCost(M, M, 0, 'deepseek/deepseek-v4-flash', bj(8, 20, 13))!;
		expect(off.total).toBeCloseTo(6, 10); // ¥1.5 + ¥4.5
	});
	it('V4 Pro：阶段 1 平板价 1M 输入 = ¥12；阶段 2 高峰 1M 输入 = ¥9', () => {
		const p1 = estimateTurnCost(M, 0, 0, 'deepseek-v4-pro', bj(8, 10, 10))!;
		expect(p1.total).toBeCloseTo(12, 10);
		const p2 = estimateTurnCost(M, 0, 0, 'deepseek-v4-pro', bj(8, 20, 10))!;
		expect(p2.total).toBeCloseTo(9, 10);
	});
	it('降价边界：2026-09-10 11:59 按阶段 2 高峰（¥12）→ 15:00 起按 V4.1 Flash 高峰（¥10）', () => {
		const before = estimateTurnCost(M, M, 0, 'deepseek-v4-flash', bj(9, 10, 11, 59))!;
		expect(before.total).toBeCloseTo(12, 10);
		const after = estimateTurnCost(M, M, 0, 'deepseek-v4-flash', bj(9, 10, 15, 0))!;
		expect(after.total).toBeCloseTo(10, 10);
	});
});

describe('DeepSeek alias 按日期路由（官方计费规则）', () => {
	it('deepseek-v4-flash 于 2026-09-15 → 官方已路由到 V4.1 Flash，按 Flash 价（高峰 ¥10）', () => {
		const est = estimateTurnCost(M, M, 0, 'deepseek/deepseek-v4-flash', bj(9, 15, 10))!;
		expect(est.total).toBeCloseTo(10, 10);
		expect(est.pricingNote ?? '').toContain('v4.1-flash');
	});
	it('deepseek-v4-flash-vision-exp 于 2026-09-15 → 同样按 V4.1 Flash 计费', () => {
		const est = estimateTurnCost(M, M, 0, 'deepseek/deepseek-v4-flash-vision-exp', bj(9, 15, 10))!;
		expect(est.total).toBeCloseTo(10, 10);
	});
	it('deepseek-v4-flash-vision-exp 于 2026-09-04（下线前工作日 10:00，计费与 V4-Flash 一致）→ 高峰 ¥12', () => {
		const est = estimateTurnCost(M, M, 0, 'deepseek/deepseek-v4-flash-vision-exp', bj(9, 4, 10))!;
		expect(est.total).toBeCloseTo(12, 10);
	});
	it('customendpoint 通道前缀与大小写均按“原厂官方价”解析（Nova / AMD 等不按渠道价）', () => {
		const a = estimateTurnCost(M, 0, 0, 'customendpoint/Nova/deepseek-v4-flash', bj(9, 15, 10))!;
		const b = estimateTurnCost(M, 0, 0, 'customendpoint/AMD-(deepseek-v4-flash)/DeepSeek-V4-Flash', bj(9, 15, 10))!;
		expect(a.total).toBeCloseTo(2, 10); // V4.1 Flash 高峰输入 ¥2/M
		expect(b.total).toBeCloseTo(2, 10);
	});
	it('deepseek-flash 在 2026-09-10 12:00 之前不存在 → N/A（不猜测）', () => {
		expect(estimateTurnCost(M, M, 0, 'deepseek-flash', bj(9, 5, 10))).toBeNull();
	});
});

// ─── 静态价格表：中国区人民币官方价 ─────────────────────────────────────────

describe('静态价格表（中国大陆官方人民币原价）', () => {
	it('J. Qwen3.8-Flash：1M 输入 + 1M 输出 = ¥3.5（严格等于官方价 ¥0.8 + ¥2.7）', () => {
		const est = estimateTurnCost(M, M, 0, 'qwen3.8-flash', bj(9, 15, 10))!;
		expect(est.currency).toBe('CNY');
		expect(est.inputCost).toBeCloseTo(0.8, 12);
		expect(est.outputCost).toBeCloseTo(2.7, 12);
		expect(est.total).toBeCloseTo(3.5, 12);
	});
	it('J2. customendpoint/Qwen/qwen3.8-flash（真实库格式）同样可定价', () => {
		const est = estimateTurnCost(M, M, 0, 'customendpoint/Qwen/qwen3.8-flash', bj(9, 15, 10))!;
		expect(est.total).toBeCloseTo(3.5, 12);
	});
	it('GLM-5.3-Flash：1M 输入 + 1M 输出 = ¥3.6（¥0.8 + ¥2.8，官方人民币价）', () => {
		const est = estimateTurnCost(M, M, 0, 'glm/glm-5.3-flash', bj(9, 15, 10))!;
		expect(est.currency).toBe('CNY');
		expect(est.total).toBeCloseTo(3.6, 12);
	});
	it('GLM-5.2（customendpoint/Nova 通道）：1M 输入 + 1M 输出 = ¥36（¥8 + ¥28）', () => {
		const est = estimateTurnCost(M, M, 0, 'customendpoint/Nova/glm-5.2', bj(9, 15, 10))!;
		expect(est.total).toBeCloseTo(36, 12);
	});
});

// ─── 币种与汇率语义（要求：CNY 不经过汇率；USD 仅折算一次） ─────────────────

describe('MiMo 官方中国区原价（2026-09-22 生效，实时推理按量）', () => {
	it('真实会话重算：mimo-v2.6-flash 23115/158 → ¥0.023431（独立手算：23115×¥1/M + 158×¥2/M）', () => {
		const est = estimateTurnCost(23115, 158, 0, 'mimo/mimo-v2.6-flash', 1790123052256)!;
		expect(est.currency).toBe('CNY');
		expect(est.inputCost).toBeCloseTo((23115 / 1e6) * 1.0, 12);
		expect(est.outputCost).toBeCloseTo((158 / 1e6) * 2.0, 12);
		expect(est.total).toBeCloseTo(0.023431, 10);
	});
	it('三款 V2.6 模型 1M 输入 + 1M 输出：flash ¥3 / pro ¥9 / ultraspeed ¥90', () => {
		expect(estimateTurnCost(M, M, 0, 'mimo/mimo-v2.6-flash', bj(9, 23, 10))!.total).toBeCloseTo(3.0, 10);
		expect(estimateTurnCost(M, M, 0, 'mimo/mimo-v2.6-pro', bj(9, 23, 10))!.total).toBeCloseTo(9.0, 10);
		expect(estimateTurnCost(M, M, 0, 'mimo/mimo-v2.6-pro-ultraspeed', bj(9, 23, 10))!.total).toBeCloseTo(90.0, 10);
	});
	it('缓存命中输入价（flash ¥0.02/M；未命中时的普通输入仍按 ¥1.00/M）', () => {
		const hit = estimateTurnCost(0, 0, M, 'mimo/mimo-v2.6-flash', bj(9, 23, 10))!;
		expect(hit.cacheReadCost).toBeCloseTo(0.02, 12);
		expect(hit.total).toBeCloseTo(0.02, 12);
		const miss = estimateTurnCost(M, 0, 0, 'mimo/mimo-v2.6-flash', bj(9, 23, 10))!;
		expect(miss.inputCost).toBeCloseTo(1.0, 12);
	});
	it('生效日期门控：2026-09-21 的请求 → N/A（不得用未来价格倒算）；09-22 00:00 起生效', () => {
		expect(estimateTurnCost(M, M, 0, 'mimo/mimo-v2.6-flash', bj(9, 21, 10))).toBeNull();
		expect(estimateTurnCost(M, M, 0, 'mimo/mimo-v2.6-flash', bj(9, 22, 0, 0))).not.toBeNull();
	});
	it('渠道前缀剥离：customendpoint/<provider>/mimo-v2.6-flash 仍命中官方价', () => {
		const est = estimateTurnCost(M, 0, 0, 'customendpoint/mimo/mimo-v2.6-flash', bj(9, 23, 10))!;
		expect(est.total).toBeCloseTo(1.0, 10);
	});
});

// ─── 币种与汇率语义（要求：CNY 不经过汇率；USD 仅折算一次） ─────────────────

describe('币种与汇率语义', () => {
	afterEach(() => setUsdToCnyRate(7.2));

	it('K. CNY 模型费用不受 usdToCnyRate 影响', () => {
		setUsdToCnyRate(7.2);
		const a = estimateTurnCost(M, M, 0, 'qwen3.8-flash', bj(9, 15, 10))!;
		setUsdToCnyRate(9.9);
		const b = estimateTurnCost(M, M, 0, 'qwen3.8-flash', bj(9, 15, 10))!;
		expect(b.total).toBe(a.total);
		// CNY 列在合并展示时不经过汇率
		expect(combineToCny(0, a.total)).toBe(a.total);
	});
	it('L. USD 模型费用随汇率变化（且仅折算一次）', () => {
		setUsdToCnyRate(7.2);
		const usd = estimateTurnCost(M, 0, 0, 'gpt-5.5', bj(9, 15, 10))!;
		expect(usd.currency).toBe('USD');
		const c1 = combineToCny(usd.total, 0);
		expect(c1).toBeCloseTo(usd.total * 7.2, 10);
		setUsdToCnyRate(9.0);
		const c2 = combineToCny(usd.total, 0);
		expect(c2).toBeCloseTo(usd.total * 9.0, 10);
		expect(c2).not.toBe(c1);
	});
});

// ─── 回退 / 缓存 / thinking ─────────────────────────────────────────────────

describe('回退与缓存语义', () => {
	it('M. 未知模型 → N/A（不套用相近模型价格）', () => {
		expect(estimateTurnCost(M, M, 0, 'customendpoint/Nova/sensenova-6.8-flash-lite', bj(9, 15, 10))).toBeNull();
		expect(estimateTurnCost(M, M, 0, 'customendpoint/RedNotes Dots AI/dots3-note-prev', bj(9, 15, 10))).toBeNull();
	});
	it('N. 无缓存数据 → 输入按官方缓存未命中价（闲时 1M 输入 = ¥1，而非命中价 ¥0.02）', () => {
		const est = estimateTurnCost(M, 0, 0, 'deepseek-flash', bj(9, 15, 22))!;
		expect(est.inputCost).toBeCloseTo(1, 12);
	});
	it('N2. 若结构化数据提供缓存命中 token，则按官方命中价分档（¥0.02/M）', () => {
		const est = estimateTurnCost(0, 0, M, 'deepseek-flash', bj(9, 15, 22))!;
		expect(est.cacheReadCost).toBeCloseTo(0.02, 12);
	});
	it('O. thinking 无重复收费：计价仅含输入/输出两项，completion 已包含 thinking token', () => {
		// 真实库中 completion_tokens 已包含 thinking（12 个含 thinking 的样本均 thinking < completion，
		// 且 importer 将 thinking 存于独立列、绝不叠加进 completion）。计价公式因此不再叠加 thinking。
		const est = estimateTurnCost(M, M, 0, 'deepseek-flash', bj(9, 14, 10))!;
		expect(est.total).toBeCloseTo((M / 1e6) * 2 + (M / 1e6) * 8, 10);
		expect('thinkingCost' in est).toBe(false);
	});
});
