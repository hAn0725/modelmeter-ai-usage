/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * UI polish regression locks — source-level assertions that keep the agreed
 * round-4 UI decisions from regressing:
 *  - Session Turn Table: no 模式 / Agent / 思考 columns; session-level
 *    「输入上下文构成」 panel present; turn-level bars kept.
 *  - “输入上下文构成” rename applied (no 提示词构成 anywhere user-visible).
 *  - Vendor Dashboard: “各模型输入 / 输出占比” 100% stacked chart replaces the
 *    old absolute “输入 vs 输出” grouped bar; table deduplicated.
 *  - Overview: pricing note is a one-liner + ⓘ 计价规则 popover; segmented
 *    control uses compact labels with tooltips.
 *  - Sidebar: hero labels (预估费用 + 官方 API 原价), keyboard support.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const read = (p: string) => readFileSync(path.join(root, p), 'utf8');

describe('Session UI 精简与构成面板', () => {
	const text = read('src/tokenUsage/sessionDashboard.ts');

	it('Turn Table 不再包含 模式 / Agent / 思考 三列', () => {
		expect(text).not.toContain('data-sort="mode"');
		expect(text).not.toContain('data-sort="agent"');
		expect(text).not.toContain('data-sort="thinking"');
		expect(text).not.toContain('<th>提示词构成</th>');
	});

	it('保留最终列清单（# 时间 模型 输入 输出 输入上下文构成 预估费用 工具调用 文件 首次响应耗时 总耗时）', () => {
		for (const label of ['#', '时间', '模型', '输入', '输出', '输入上下文构成', '预估费用', '工具调用', '文件', '首次响应耗时', '总耗时']) {
			expect(text).toContain(`>${label}</th>`);
		}
	});

	it('新增会话级输入上下文构成面板（加权 + coverage 提示 + 约 X Token tooltip）', () => {
		expect(text).toContain('aggregateSessionContext');
		expect(text).toContain('输入上下文构成（整个会话）');
		expect(text).toContain('按输入 Token 加权聚合');
		expect(text).toContain('构成数据覆盖');
		expect(text).toContain('约 ${formatTokenCount');
	});

	it('Turn 单轮彩色构成条保留（两层分析）', () => {
		expect(text).toContain('_promptBar');
		expect(text).toContain('pbar-s');
	});
});

describe('“输入上下文构成”全局改名', () => {
	it('Model Dashboard / Session Dashboard 不再出现“提示词构成”', () => {
		expect(read('src/tokenUsage/modelDashboard.ts')).not.toContain('提示词构成');
		expect(read('src/tokenUsage/sessionDashboard.ts')).not.toContain('提示词构成');
	});
});

describe('Vendor Dashboard 图表职责', () => {
	const text = read('src/tokenUsage/vendorDashboard.ts');

	it('用 100% 堆叠图替换绝对值横条', () => {
		expect(text).not.toContain('各模型输入 vs 输出');
		expect(text).toContain('各模型输入 / 输出占比');
		expect(text).toContain('ioChart');
		expect(text).toContain('max:100');
		expect(text).toContain('inShare');
		expect(text).toContain('outShare');
	});

	it('零 Token 模型不绘制（无 NaN/Infinity 路径）', () => {
		expect(text).toContain('modelEntries.filter(m => m.totalTokens > 0)');
	});

	it('表格删除重复的“输入输出比”迷你条列', () => {
		expect(text).not.toContain('输入输出比');
	});
});

describe('Overview 与 Sidebar polish', () => {
	it('Overview：一句话计价说明 + ⓘ 计价规则 popover（含 utility 说明）', () => {
		const text = read('src/tokenUsage/tokenUsageDashboard.ts');
		expect(text).toContain('费用按中国大陆官方 API 标准按量原价估算');
		expect(text).toContain('ⓘ 计价规则');
		expect(text).toContain('VS Code Utility Model 后台调用可能不进入统计');
	});

	it('Overview：紧凑分段控件（7 天 / 30 天 / 自选 + title 完整语义）', () => {
		const text = read('src/tokenUsage/tokenUsageDashboard.ts');
		expect(text).toContain('>7 天</button>');
		expect(text).toContain('>30 天</button>');
		expect(text).toContain('>自选</button>');
		expect(text).toContain('title="最近 7 天"');
		expect(text).toContain('title="自选开始日期（含当天）"');
	});

	it('Sidebar：第三指标为 预估费用 + 官方 API 原价；键盘可达', () => {
		const text = read('src/tokenUsage/modelMeterSidebar.ts');
		expect(text).toContain('>预估费用</div>');
		expect(text).toContain('官方 API 原价');
		expect(text).toContain('tabindex="0"');
		expect(text).toContain('aria-label=');
		expect(text).toContain("ev.key !== 'Enter'");
	});
});
