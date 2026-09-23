/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModelMeter sidebar — view-model preparation tests.
 *
 * `_collectData()` is exercised with a fake MetricsService so the formatting,
 * sorting and N/A semantics of the webview payload are locked down without a
 * VS Code host (the webview HTML itself is rendering-only).
 */

import { describe, it, expect } from 'vitest';
import { ModelMeterSidebarProvider } from '../tokenUsage/modelMeterSidebar';
import type { SidebarData } from '../tokenUsage/modelMeterSidebar';
import type { VendorAgg, SessionSummary } from '../tokenUsage/metricsDatabase';
import type { TokenUsageTracker } from '../tokenUsage/tokenUsageTracker';

function makeVendor(partial: Partial<VendorAgg> & { vendor: string }): VendorAgg {
	return {
		promptTokens: 0, completionTokens: 0, totalTokens: 0,
		costUsd: 0, costCny: 0, unpricedCount: 0, requestCount: 0,
		...partial,
	} as VendorAgg;
}

function makeSession(partial: Partial<SessionSummary> & { session_id: string }): SessionSummary {
	return {
		creation_date: 0, initial_location: null, request_count: 0,
		session_vendor: null, session_model_name: null, session_extension: null,
		has_pending_edits: 0, turnCount: 0, promptTokens: 0, completionTokens: 0,
		totalTokens: 0, costUsd: 0, costCny: 0, agent_ids: null,
		first_turn_at: null, last_turn_at: null,
		...partial,
	} as SessionSummary;
}

function collect(vendors: VendorAgg[], sessions: SessionSummary[], filter: { days: number; modelName?: string } = { days: 7 }): Promise<SidebarData> {
	const fakeTracker = {
		metricsService: {
			getVendorBreakdown7d: async () => vendors,
			listSessions: async () => sessions,
		},
	};
	const provider = new ModelMeterSidebarProvider(
		fakeTracker as unknown as TokenUsageTracker,
		'0.2.0',
		() => filter,
	);
	return (provider as unknown as { _collectData(): Promise<SidebarData> })._collectData();
}

describe('ModelMeterSidebar 数据准备', () => {
	it('厂商行：真实 id + 显示名、按 Token 降序、pct 归一化（最大 100，最小 ≥2）、颜色循环', async () => {
		const data = await collect([
			makeVendor({ vendor: 'mimo', totalTokens: 23273, requestCount: 1, unpricedCount: 1 }),
			makeVendor({ vendor: 'deepseek', totalTokens: 7961574, requestCount: 29, costCny: 11.63 }),
			makeVendor({ vendor: 'Qwen', totalTokens: 1410874, requestCount: 16, costCny: 1.35 }),
		], []);

		expect(data.vendors.map(v => v.id)).toEqual(['deepseek', 'Qwen', 'mimo']);
		expect(data.vendors.map(v => v.name)).toEqual(['DeepSeek', 'Qwen', 'MiMo']);
		expect(data.vendors[0].pct).toBe(100);
		expect(data.vendors[1].pct).toBe(18);
		expect(data.vendors[2].pct).toBeGreaterThanOrEqual(2);
		expect(data.vendors.map(v => v.color)).toEqual([0, 1, 2]);
		expect(data.vendors[0].meta).toBe('7.96M · 29 次');
		expect(data.vendors[2].meta).toBe('23.3K · 1 次');
		// 23273 + 7961574 + 1410874 = 9 395 721 → 9.40M
		expect(data.week.tokens).toBe('9.40M');
		expect(data.week.requests).toBe('46');
	});

	it('全部模型无官方价时费用显示 —，costNote 保持口径说明', async () => {
		const data = await collect([
			makeVendor({ vendor: 'Dots', totalTokens: 1000, requestCount: 2, unpricedCount: 2 }),
		], []);
		expect(data.week.cost).toBe('—');
		expect(data.week.costNote).toBe('官方 API 原价');
	});

	it('有价格时显示 ¥ 金额（CNY 不经汇率；USD 规则折算一次）', async () => {
		const data = await collect([
			makeVendor({ vendor: 'deepseek', totalTokens: 1000, requestCount: 1, costCny: 12.345 }),
			makeVendor({ vendor: 'openai', totalTokens: 1000, requestCount: 1, costUsd: 1.0 }),
		], []);
		// 12.345 + 1.0×7.2 = ¥19.545 → formatCnyCompact(19.545) = ¥19.55（四舍五入 2 位）
		expect(data.week.cost).toBe('¥19.55');
	});

	it('会话行：按创建时间降序、标题回退（model_name → 厂商显示名）、费用为 0 时右侧留空', async () => {
		const data = await collect([], [
			makeSession({ session_id: 's-old', creation_date: 1000, session_model_name: 'GLM-5.3-Flash', turnCount: 3, costCny: 0.11 }),
			makeSession({ session_id: 's-new', creation_date: 2000, session_model_name: 'MiMo V2.6 Flash', turnCount: 1, costCny: 0 }),
			makeSession({ session_id: 's-mid', creation_date: 1500, session_vendor: 'customendpoint/Foo', turnCount: 2, costCny: 0 }),
		]);

		expect(data.sessions.map(s => s.id)).toEqual(['s-new', 's-mid', 's-old']);
		expect(data.sessions[0].title).toBe('MiMo V2.6 Flash');
		expect(data.sessions[0].right).toBe('');
		// vendor 回退：'customendpoint/Foo' 无显示映射 → 原样；费用 0 → 右列空
		expect(data.sessions[1].title).toBe('customendpoint/Foo');
		expect(data.sessions[1].right).toBe('');
		expect(data.sessions[2].right).toBe('¥0.11');
		expect(data.sessions[2].meta).toMatch(/3 轮 · \d{2}-\d{2} \d{2}:\d{2}$/);
	});

	it('会话筛选提示：默认“近 7 天”，自定义天数、全部时间与模型过滤', async () => {
		expect((await collect([], [], { days: 7 })).sessionsHint).toBe('近 7 天');
		expect((await collect([], [], { days: 90 })).sessionsHint).toBe('近 90 天');
		expect((await collect([], [], { days: 3650 })).sessionsHint).toBe('全部时间');
		expect((await collect([], [], { days: 30, modelName: 'GLM-5.3-Flash' })).sessionsHint).toBe('近 30 天 · GLM-5.3-Flash');
	});

	it('空数据时不崩溃：hero 归零、vendors/sessions 为空、empty=true', async () => {
		const data = await collect([], []);
		expect(data.week.tokens).toBe('0');
		expect(data.week.requests).toBe('0');
		expect(data.vendors).toEqual([]);
		expect(data.sessions).toEqual([]);
		expect(data.empty).toBe(true);
		expect(data.version).toBe('0.2.0');
	});
});
