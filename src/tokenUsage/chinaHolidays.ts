/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * 中国法定节假日日历（离线数据，用于 DeepSeek 峰谷计价的“工作日 / 节假日”判定）。
 *
 * 官方来源：
 *  - 2026 年：国务院办公厅《关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号，
 *    2025-11-04 发布） https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 *
 * 维护方式：每年国务院发布次年放假安排后，向 HOLIDAY_RANGES 添加对应年份即可。
 * 未收录年份按“无法定节假日”处理（并输出一次警告，提示更新本文件）。
 *
 * 重要（DeepSeek 官方口径）：高峰时段为“北京时间周一至周五（不含中国法定节假日）
 * 9:00-12:00、14:00-18:00”；其余时段——包括周末及中国法定节假日全天——均为空闲时段。
 * 因此“调休补班”的周六 / 周日按官方口径仍属周末 → 闲时；MAKEUP_WORKDAYS 仅作记录参考，
 * 不参与高峰判定。
 */

/** 每年法定节假日放假日期闭区间 [起, 止]（含端点），格式 YYYY-MM-DD。 */
const HOLIDAY_RANGES: Readonly<Record<number, readonly (readonly [string, string])[]>> = {
	2026: [
		['2026-01-01', '2026-01-03'], // 元旦（1月4日周日上班）
		['2026-02-15', '2026-02-23'], // 春节（2月14日、2月28日周六上班）
		['2026-04-04', '2026-04-06'], // 清明节
		['2026-05-01', '2026-05-05'], // 劳动节（5月9日周六上班）
		['2026-06-19', '2026-06-21'], // 端午节
		['2026-09-25', '2026-09-27'], // 中秋节
		['2026-10-01', '2026-10-07'], // 国庆节（9月20日周日、10月10日周六上班）
	],
};

/** 调休补班日（仅记录参考；官方规则按周末全天闲时处理，不用于高峰判定）。 */
export const MAKEUP_WORKDAYS: Readonly<Record<number, readonly string[]>> = {
	2026: ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10'],
};

/** 中国标准时间固定 UTC+8，无夏令时。 */
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

export interface BeijingClock {
	readonly year: number;
	/** 1-12 */
	readonly month: number;
	/** 1-31 */
	readonly day: number;
	/** 0=周日, 1=周一 … 6=周六 */
	readonly weekday: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

/**
 * 将 UTC 毫秒时间戳转换为北京时间（UTC+8）日历字段。
 * 通过固定偏移 + getUTC* 计算，不受运行环境本地时区影响。
 */
export function beijingClockFromUtcMs(utcMs: number): BeijingClock {
	const d = new Date(utcMs + BEIJING_OFFSET_MS);
	return {
		year: d.getUTCFullYear(),
		month: d.getUTCMonth() + 1,
		day: d.getUTCDate(),
		weekday: d.getUTCDay(),
		hour: d.getUTCHours(),
		minute: d.getUTCMinutes(),
		second: d.getUTCSeconds(),
	};
}

function ymdNumber(y: number, m: number, d: number): number { return y * 10000 + m * 100 + d; }
function rangeStartNumber(s: string): number { return Number(s.slice(0, 4)) * 10000 + Number(s.slice(5, 7)) * 100 + Number(s.slice(8, 10)); }

const _missingYearWarned = new Set<number>();

/** 判断给定的北京日期（年/月/日）是否为国务院公布的法定节假日放假日。 */
export function isChinaStatutoryHoliday(year: number, month: number, day: number): boolean {
	const ranges = HOLIDAY_RANGES[year];
	if (!ranges) {
		if (!_missingYearWarned.has(year)) {
			_missingYearWarned.add(year);
			console.warn(`[ChinaHolidays] 未收录 ${year} 年节假日数据，按“无法定节假日”处理（请更新 src/tokenUsage/chinaHolidays.ts）`);
		}
		return false;
	}
	const key = ymdNumber(year, month, day);
	for (const [from, to] of ranges) {
		if (key >= rangeStartNumber(from) && key <= rangeStartNumber(to)) { return true; }
	}
	return false;
}
