/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Inline-script syntax gate for every generated webview page.
 *
 * The dashboards embed large inline <script> blocks (Chart.js setup, table
 * rendering). A brace/paren typo there is invisible to tsc and unit tests but
 * breaks the whole page at runtime. This spec renders each page with stub data
 * and compiles every inline script with `vm.Script` — the same check that
 * caught a real Chart.js brace regression during the round-4 UI polish.
 */

import { describe, it, expect } from 'vitest';
import * as vm from 'node:vm';

// Modules under test import 'vscode' (aliased to the shim by vitest.conf).
import { TokenUsageDashboard } from '../tokenUsage/tokenUsageDashboard';
import { VendorDashboard } from '../tokenUsage/vendorDashboard';
import { ModelDashboard } from '../tokenUsage/modelDashboard';
import { SessionDashboard } from '../tokenUsage/sessionDashboard';

const day = (i: number) => { const d = new Date(); d.setDate(d.getDate() - i); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const row = { date: day(1), totalPromptTokens: 10, totalCompletionTokens: 1, totalTokens: 11, estimatedCostUsd: 0.1, estimatedCostCny: 0, requestCount: 1 };
const modelAgg = { modelId: 'deepseek/x', promptTokens: 10, completionTokens: 1, costUsd: 0, costCny: 0.5, unpricedCount: 0, requestCount: 2 };
const turn = {
	request_id: 'r', session_id: 's', timestamp: Date.now(), completed_at: null, elapsed_ms: 100, first_progress_ms: 10,
	total_elapsed_ms: 100, time_spent_waiting: null, model_id: 'mimo/x', vendor: 'mimo', model_name: null, resolved_model: null,
	agent_id: null, agent_extension: null, agent_name: null, prompt_tokens: 10, completion_tokens: 1, output_buffer: null,
	system_instructions_pct: 10, tool_definitions_pct: 10, messages_pct: 40, files_pct: 10, tool_results_pct: 30,
	model_state: 1, vote: null, user_message_length: null, user_message_parts: 0, mode_kind: 'agent', is_system_initiated: 0,
	response_part_count: 0, content_ref_count: 0, code_citation_count: 0, edited_file_count: 0, followup_count: 0,
	variable_count: 0, tool_call_rounds: 0, tool_call_count: 0, thinking_tokens: 0, estimated_cost_usd: null, estimated_cost_cny: 0.001,
};

function scriptsOf(html: string): string[] {
	return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

function assertScriptsCompile(name: string, html: string): void {
	// 0.4.0: every generated page must carry its Content-Security-Policy meta
	// (script tags use per-page nonces).
	expect(html, `${name} 应包含 CSP meta`).toContain('Content-Security-Policy');
	const scripts = scriptsOf(html);
	expect(scripts.length, `${name} 应包含内联脚本`).toBeGreaterThan(0);
	for (let i = 0; i < scripts.length; i++) {
		try {
			new vm.Script(scripts[i]);
		} catch (e) {
			throw new Error(`${name} 内联脚本 #${i} 语法错误: ${(e as Error).message}`);
		}
	}
}

describe('Dashboard 内联脚本语法', () => {
	it('Overview 页面脚本可编译', async () => {
		const inst = Object.create(TokenUsageDashboard.prototype) as {
			_tracker: unknown; _days: number; _rangeMode: string; _sinceDate: string; _renderAsync(): Promise<string>;
		};
		inst._days = 30; inst._rangeMode = 'month'; inst._sinceDate = '';
		inst._tracker = {
			metricsService: {
				getDashboardSummary: async () => ({
					today: { ...row, date: day(0) }, thisWeek: [row], thisMonth: [row],
					allTime: { totalPromptTokens: 100, totalCompletionTokens: 10, totalCostUsd: 0.2, totalCostCny: 0.1, firstTrackedDate: '2026-09-05', daysTracked: 5, sessionCount: 2, requestCount: 3 },
					vendorBreakdown: [{ vendor: 'deepseek', promptTokens: 10, completionTokens: 1, totalTokens: 11, costUsd: 0, costCny: 0.5, unpricedCount: 0, requestCount: 2 }],
					modelBreakdown: [{ ...modelAgg, costUsd: 0, costCny: 0.5 }],
				}),
				getDayTotalsByVendor: async () => [{ ...row, vendor: 'v' }],
			},
		};
		assertScriptsCompile('overview', await inst._renderAsync());
	});

	it('Vendor 页面脚本可编译', async () => {
		const inst = Object.create(VendorDashboard.prototype) as {
			_tracker: unknown; _days: number; _rangeMode: string; _sinceDate: string; _activeVendor: string; _render(): Promise<string>;
		};
		inst._days = 30; inst._rangeMode = 'month'; inst._sinceDate = ''; inst._activeVendor = 'deepseek';
		inst._tracker = {
			metricsService: {
				getVendorViewSummary: async () => ({ models: [modelAgg], dailyByModel: [{ ...row, modelId: 'deepseek/x' }], allTimeTokens: 11, allTimeRequests: 2, firstTrackedDate: null }),
			},
		};
		assertScriptsCompile('vendor', await inst._render());
	});

	it('Model 页面脚本可编译', async () => {
		const inst = Object.create(ModelDashboard.prototype) as {
			_tracker: unknown; _days: number; _rangeMode: string; _sinceDate: string; _render(): Promise<string>;
		};
		inst._days = 30; inst._rangeMode = 'month'; inst._sinceDate = '';
		inst._tracker = {
			metricsService: {
				getModelViewSummary: async () => ({ models: [modelAgg], dailyByModel: [{ ...row, modelId: 'deepseek/x' }], promptBreakdowns: [], firstTrackedDate: null }),
				getAllVendors: async () => ['deepseek'],
			},
		};
		assertScriptsCompile('model', await inst._render());
	});

	it('Session 页面脚本可编译（含上下文面板与轮次表渲染器）', async () => {
		const inst = Object.create(SessionDashboard.prototype) as {
			_tracker: unknown; _sessionId: string; _renderAsync(): Promise<string>;
		};
		inst._sessionId = 's';
		inst._tracker = {
			metricsService: {
				getSessionDetail: async () => ({
					session: { session_id: 's', creation_date: Date.now(), session_model_id: null, session_vendor: null, session_model_name: null, session_family: null, session_extension: null, session_is_byok: 0, has_pending_edits: 0 },
					turns: [turn],
				}),
			},
		};
		assertScriptsCompile('session', await inst._renderAsync());
	});
});
