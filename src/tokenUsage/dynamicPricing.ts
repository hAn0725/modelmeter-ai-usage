/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * DeepSeek 动态计价规则（官方 API 原价，人民币）。
 *
 * 统一定价口径：假设请求全部通过 DeepSeek 官方 API 按标准按量原价调用，
 * 忽略 Token Plan / Coding Plan / 免费额度 / 第三方渠道等真实使用方式。
 *
 * 官方依据（均已核对原始页面，2026-09-23）：
 *  - 模型与价格：https://api-docs.deepseek.com/zh-cn/quick_start/pricing
 *  - 更新日志（价格生效时间线）：https://api-docs.deepseek.com/zh-cn/updates
 *  - V4-Flash / V4-Pro 首发定价：news260424（图 v4-price.png）
 *  - 峰谷定价生效 2026-08-17 00:00（北京时间）：news260813（图 v4_260813_price_cn.png）
 *  - V4.1 Flash 上线、旧模型下线与降价生效 2026-09-10 12:00（北京时间）：news260910
 *  - 旧模型名路由与计费：pricing 页脚注 (1)
 *
 * 峰谷判定（官方原文）：北京时间周一至周五（不含中国法定节假日）9:00-12:00、
 * 14:00-18:00 为高峰时段；其余时段，包括周末及中国法定节假日全天均为空闲时段。
 * 空闲时段价格为高峰时段价格的一半。
 */

import { beijingClockFromUtcMs, isChinaStatutoryHoliday } from './chinaHolidays';

/** 人民币单价（元 / 百万 tokens）。 */
export interface CnyTokenRates {
	readonly cacheHit: number;
	readonly cacheMiss: number;
	readonly output: number;
}

export interface DeepseekPricingDecision {
	/** 计价所用的实际模型版本标识（如 'deepseek-v4.1-flash'）。 */
	readonly model: string;
	/** 是否命中高峰时段。 */
	readonly peak: boolean;
	/** 适用的官方人民币单价。 */
	readonly rates: CnyTokenRates;
	/** 规则说明（便于诊断与测试断言）。 */
	readonly note: string;
}

type PricingKind = 'v4-flash' | 'v4-pro' | 'v4.1-flash';

interface PricePhase {
	readonly kind: PricingKind;
	/** 生效起点（含），UTC 毫秒；null 表示不早于系列起始。 */
	readonly fromUtcMs: number | null;
	/** 生效终点（不含），UTC 毫秒；null 表示至今。 */
	readonly untilUtcMs: number | null;
	/** 无峰谷的统一价（早期阶段）。 */
	readonly flat?: CnyTokenRates;
	readonly offPeak?: CnyTokenRates;
	readonly peak?: CnyTokenRates;
	readonly source: string;
}

/** 北京时间 → UTC 毫秒（UTC+8 固定，无夏令时）。 */
function bj(y: number, m: number, d: number, h = 0, min = 0): number {
	return Date.UTC(y, m - 1, d, h - 8, min);
}

/** 峰谷定价生效时刻：北京时间 2026-08-17 00:00。 */
export const DEEPSEEK_PEAK_PRICING_FROM_MS = bj(2026, 8, 17);
/** V4.1 Flash 上线与旧模型下线时刻：北京时间 2026-09-10 12:00。 */
export const DEEPSEEK_V41_ROUTING_FROM_MS = bj(2026, 9, 10, 12);

const PHASES: readonly PricePhase[] = [
	// ── 阶段 1：2026-04-24 首发 ~ 2026-08-16（无峰谷统一价）──────
	{
		kind: 'v4-flash', fromUtcMs: null, untilUtcMs: DEEPSEEK_PEAK_PRICING_FROM_MS,
		flat: { cacheHit: 0.2, cacheMiss: 1, output: 2 },
		source: 'V4 首发定价（news260424）',
	},
	{
		kind: 'v4-pro', fromUtcMs: null, untilUtcMs: DEEPSEEK_PEAK_PRICING_FROM_MS,
		flat: { cacheHit: 1, cacheMiss: 12, output: 24 },
		source: 'V4 首发定价（news260424）',
	},
	// ── 阶段 2：2026-08-17 ~ 2026-09-10 12:00（峰谷定价第一版）─────
	{
		kind: 'v4-flash', fromUtcMs: DEEPSEEK_PEAK_PRICING_FROM_MS, untilUtcMs: DEEPSEEK_V41_ROUTING_FROM_MS,
		offPeak: { cacheHit: 0.05, cacheMiss: 1.5, output: 4.5 },
		peak: { cacheHit: 0.1, cacheMiss: 3, output: 9 },
		source: '2026-08-17 峰谷价格表（news260813）',
	},
	{
		kind: 'v4-pro', fromUtcMs: DEEPSEEK_PEAK_PRICING_FROM_MS, untilUtcMs: null,
		offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
		peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
		source: '2026-08-17 峰谷价格表（news260813）；官方公告 V4 Pro 计费延续不变',
	},
	// ── 阶段 3：2026-09-10 12:00 ~ 现在（V4.1 Flash 定价）──────────
	{
		kind: 'v4.1-flash', fromUtcMs: DEEPSEEK_V41_ROUTING_FROM_MS, untilUtcMs: null,
		offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
		peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
		source: '2026-09-10 12:00 起价格表（news260910 与模型与价格页）',
	},
];

/**
 * 从 modelId 解析 DeepSeek 规范模型名（小写、取末段、归一分隔符）。
 * 支持 customendpoint 前缀形式，如 `customendpoint/AMD-(deepseek-v4-flash)/DeepSeek-V4-Flash`。
 * 返回 null 表示不是可识别的 DeepSeek 官方模型。
 */
export function canonicalizeDeepseekId(modelId: string): string | null {
	if (!modelId) { return null; }
	const last = modelId.toLowerCase().split('/').pop() ?? '';
	const norm = last.replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
	switch (norm) {
		case 'deepseek-flash':
		case 'deepseek-v4-flash':
		case 'deepseek-v4-flash-vision-exp':
		case 'deepseek-v4-pro':
			return norm;
		default:
			return null;
	}
}

/**
 * 官方峰谷判定：北京时间周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00 为高峰；
 * 其余时段（含周末与法定节假日全天）为空闲。
 * 注意：调休补班的周六 / 周日仍按周末处理（官方口径“周末全天闲时”）。
 */
export function isDeepseekPeak(utcMs: number): boolean {
	const c = beijingClockFromUtcMs(utcMs);
	if (c.weekday === 0 || c.weekday === 6) { return false; }
	if (isChinaStatutoryHoliday(c.year, c.month, c.day)) { return false; }
	const minutes = c.hour * 60 + c.minute;
	return (minutes >= 9 * 60 && minutes < 12 * 60) || (minutes >= 14 * 60 && minutes < 18 * 60);
}

/**
 * 根据请求时间解析 DeepSeek 官方计价：
 *  - alias 路由：`deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` 在 2026-09-10 12:00 前
 *    按对应旧模型计费（vision-exp 与 V4-Flash 同价），之后官方将其路由到 V4.1 Flash 并按 Flash 计费；
 *  - 历史生效日期：按请求发生时间匹配对应价格阶段；
 *  - 峰谷：按北京时间与法定节假日判定。
 * 返回 null 表示该时间点无可确认的官方价格（保持 N/A，不做猜测）。
 */
export function resolveDeepseekPricing(modelId: string, utcMs: number): DeepseekPricingDecision | null {
	const canon = canonicalizeDeepseekId(modelId);
	if (!canon) { return null; }

	let kind: PricingKind;
	switch (canon) {
		case 'deepseek-flash':
			// V4.1 Flash 自 2026-09-10 12:00 起存在；此前无该模型记录。
			if (utcMs < DEEPSEEK_V41_ROUTING_FROM_MS) { return null; }
			kind = 'v4.1-flash';
			break;
		case 'deepseek-v4-flash':
		case 'deepseek-v4-flash-vision-exp':
			kind = utcMs >= DEEPSEEK_V41_ROUTING_FROM_MS ? 'v4.1-flash' : 'v4-flash';
			break;
		case 'deepseek-v4-pro':
			kind = 'v4-pro';
			break;
		default:
			return null;
	}

	const phase = PHASES.find(p =>
		p.kind === kind
		&& (p.fromUtcMs === null || utcMs >= p.fromUtcMs)
		&& (p.untilUtcMs === null || utcMs < p.untilUtcMs),
	);
	if (!phase) { return null; }

	const modelLabel = kind === 'v4.1-flash' ? 'deepseek-v4.1-flash' : `deepseek-${kind}`;
	if (phase.flat) {
		return {
			model: modelLabel,
			peak: false,
			rates: phase.flat,
			note: `${canon} → ${modelLabel}（无峰谷统一价；${phase.source}）`,
		};
	}
	const peak = isDeepseekPeak(utcMs);
	return {
		model: modelLabel,
		peak,
		rates: peak ? phase.peak! : phase.offPeak!,
		note: `${canon} → ${modelLabel}（${peak ? '高峰' : '空闲'}时段；${phase.source}）`,
	};
}
