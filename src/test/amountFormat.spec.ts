/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * UI amount formatting tests — display-only rules, and host/webview parity of
 * the embedded `AMOUNT_FMT_JS` mirror.
 */

import { describe, it, expect } from 'vitest';
import { formatCnyUi, formatCnyAxis, formatCnyTiny, AMOUNT_FMT_JS } from '../tokenUsage/amountFormat';

describe('amountFormat.formatCnyUi', () => {
	it('0 → ¥0（无小数）', () => {
		expect(formatCnyUi(0)).toBe('¥0');
		expect(formatCnyUi(-0)).toBe('¥0');
	});

	it('0 < cost < ¥0.01 → 最多 4 位小数（去尾零）', () => {
		expect(formatCnyUi(0.0023)).toBe('¥0.0023');
		expect(formatCnyUi(0.005)).toBe('¥0.005');
		expect(formatCnyUi(0.0001)).toBe('¥0.0001');
		// 4 位小数下四舍五入到 0 → 折叠为 ¥0（图表轴不会出现 ¥0.0000）
		expect(formatCnyUi(0.00004)).toBe('¥0');
	});

	it('cost ≥ ¥0.01 → 恰好 2 位小数', () => {
		expect(formatCnyUi(0.01)).toBe('¥0.01');
		expect(formatCnyUi(14.49)).toBe('¥14.49');
		expect(formatCnyUi(68.4035)).toBe('¥68.40');
		expect(formatCnyUi(19.545)).toBe('¥19.55');
	});

	it('轴格式与主格式一致，且不会产生 ¥0.0000 / ¥2.0000', () => {
		for (const v of [0, 0.00004, 0.0023, 2, 19.545]) {
			expect(formatCnyAxis(v)).toBe(formatCnyUi(v));
		}
		expect(formatCnyAxis(2)).toBe('¥2.00');
		expect(formatCnyAxis(0)).toBe('¥0');
	});
});

describe('amountFormat.formatCnyTiny', () => {
	it('Tooltip 变体：极小费用保留 4 位小数（不去尾零）', () => {
		expect(formatCnyTiny(0.00004)).toBe('¥0.0000');
		expect(formatCnyTiny(0.0023)).toBe('¥0.0023');
		expect(formatCnyTiny(0.01)).toBe('¥0.01');
		expect(formatCnyTiny(19.545)).toBe('¥19.55');
		expect(formatCnyTiny(0)).toBe('¥0');
	});
});

describe('amountFormat.AMOUNT_FMT_JS（webview 镜像与宿主一致）', () => {
	it('镜像函数对样例值输出与 TS 版本一致', () => {
		const fn = new Function(AMOUNT_FMT_JS + '; return { ui: fmtCnyUi, axis: fmtCnyAxis, tiny: fmtCnyTiny };')() as {
			ui: (v: number) => string; axis: (v: number) => string; tiny: (v: number) => string;
		};
		const samples = [0, 0.00004, 0.0001, 0.0023, 0.005, 0.01, 2, 14.49, 19.545, 68.4035];
		for (const v of samples) {
			expect(fn.ui(v)).toBe(formatCnyUi(v));
			expect(fn.axis(v)).toBe(formatCnyAxis(v));
			expect(fn.tiny(v)).toBe(formatCnyTiny(v));
		}
	});
});
