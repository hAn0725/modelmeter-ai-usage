/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Session-level input-context aggregation tests: weighted (not averaged)
 * percentages, coverage of missing breakdown turns, and zero-guards.
 */

import { describe, it, expect } from 'vitest';
import { aggregateSessionContext } from '../tokenUsage/contextBreakdown';
import type { PromptBreakdownTurn } from '../tokenUsage/contextBreakdown';

function turn(prompt: number, sys: number, tools: number, msg: number, files: number, results: number): PromptBreakdownTurn {
	return {
		prompt_tokens: prompt,
		system_instructions_pct: sys,
		tool_definitions_pct: tools,
		messages_pct: msg,
		files_pct: files,
		tool_results_pct: results,
	};
}

describe('aggregateSessionContext', () => {
	it('按输入 Token 加权聚合，而非对百分比做算术平均', () => {
		// turn2 输入 Token 是 turn1 的 9 倍：system 加权应为 28%，而不是 (10+30)/2=20%
		const agg = aggregateSessionContext([
			turn(100, 10, 0, 90, 0, 0),
			turn(900, 30, 0, 70, 0, 0),
		]);
		const sys = agg.categories.find(c => c.key === 'system')!;
		const msg = agg.categories.find(c => c.key === 'messages')!;
		expect(sys.tokens).toBeCloseTo(10 + 270, 6);
		expect(sys.pct).toBeCloseTo(28, 6);
		expect(msg.pct).toBeCloseTo(72, 6);
		expect(agg.coveredPromptTokens).toBe(1000);
		expect(agg.totalPromptTokens).toBe(1000);
		expect(agg.coverage).toBe(1);
		expect(agg.hasData).toBe(true);
	});

	it('缺失 breakdown 的轮次不计入分母，coverage 如实反映', () => {
		const agg = aggregateSessionContext([
			turn(1000, 95, 5, 0, 0, 0),
			turn(500, 0, 0, 0, 0, 0), // 无构成数据
		]);
		expect(agg.coveredPromptTokens).toBe(1000);
		expect(agg.totalPromptTokens).toBe(1500);
		expect(agg.coverage).toBeCloseTo(2 / 3, 6);
		// 百分比分母是「有构成数据」的 prompt tokens
		const sys = agg.categories.find(c => c.key === 'system')!;
		expect(sys.pct).toBeCloseTo(95, 6);
	});

	it('空会话 / total=0：无 NaN、无 Infinity、hasData=false', () => {
		const empty = aggregateSessionContext([]);
		expect(empty.hasData).toBe(false);
		expect(empty.coverage).toBe(0);
		expect(empty.coveredPromptTokens).toBe(0);
		expect(empty.totalPromptTokens).toBe(0);
		for (const c of empty.categories) {
			expect(Number.isFinite(c.pct)).toBe(true);
			expect(Number.isFinite(c.tokens)).toBe(true);
			expect(c.pct).toBe(0);
		}
	});

	it('prompt=0 或百分比全为 0 的轮次被跳过（不会除零）', () => {
		const agg = aggregateSessionContext([
			turn(0, 50, 50, 0, 0, 0), // 无 token：跳过
			turn(200, 0, 0, 0, 0, 0), // 无构成：跳过
			turn(800, 25, 25, 25, 25, 0),
		]);
		expect(agg.coveredPromptTokens).toBe(800);
		expect(agg.totalPromptTokens).toBe(1000);
		const tools = agg.categories.find(c => c.key === 'tools')!;
		expect(tools.tokens).toBeCloseTo(200, 6);
		expect(tools.pct).toBeCloseTo(25, 6);
	});

	it('五类 token 总和 ≈ covered prompt tokens（百分比接近 100 时）', () => {
		const agg = aggregateSessionContext([
			turn(1000, 20, 30, 40, 5, 5),
			turn(2000, 10, 20, 50, 10, 10),
		]);
		const sum = agg.categories.reduce((s, c) => s + c.tokens, 0);
		expect(sum).toBeCloseTo(agg.coveredPromptTokens, 6);
	});
});
