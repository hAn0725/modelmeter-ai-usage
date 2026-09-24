/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sidebar webview gate for the 0.3.0 “账户与套餐” section:
 *  - the generated HTML stays CSP-clean (nonce'd scripts, no inline styles)
 *  - every inline script compiles (vm.Script — catches template-string bugs)
 *  - the account section markup + message wiring exist (manage / toggle /
 *    refresh / connect), and message types map to the host whitelist.
 */

import { describe, it, expect } from 'vitest';
import * as vm from 'node:vm';
import { ModelMeterSidebarProvider } from '../tokenUsage/modelMeterSidebar';
import type { TokenUsageTracker } from '../tokenUsage/tokenUsageTracker';
import type { AccountUsageService } from '../accountUsage/accountUsageService';
import { ACCOUNT_PROVIDERS } from '../accountUsage/providerRegistry';
import type { AccountViewState } from '../accountUsage/types';

function buildHtml(): string {
	const fakeTracker = {
		metricsService: {
			getVendorBreakdown7d: async () => [],
			listSessions: async () => [],
		},
	};
	const states: AccountViewState[] = ACCOUNT_PROVIDERS.map(def => ({
		provider: def.id,
		connected: def.id === 'deepseek',
		cached: def.id === 'deepseek'
			? {
				snapshot: {
					provider: 'deepseek', billingMode: 'payg',
					balance: { value: 38.62, currency: 'CNY' },
					windows: [], source: 'official-api', fetchedAt: Date.now(),
				},
				updatedAt: Date.now() - 60_000,
			}
			: null,
	}));
	const fakeAccounts = {
		getAll: () => states,
		currentProvider: () => 'deepseek',
		ensureFresh: async () => { /* no-op */ },
	};
	const provider = new ModelMeterSidebarProvider(
		fakeTracker as unknown as TokenUsageTracker,
		'0.3.0',
		() => ({ days: 7 }),
		fakeAccounts as unknown as AccountUsageService,
	);
	return (provider as unknown as { _buildHtml(webview: unknown): string })._buildHtml({});
}

describe('侧边栏 HTML（账户与套餐）', () => {
	const html = buildHtml();

	it('内联脚本全部可编译（含 renderAccounts / focusAccount 处理）', () => {
		const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
		expect(scripts.length).toBeGreaterThan(0);
		for (const script of scripts) {
			expect(() => new vm.Script(script)).not.toThrow();
		}
		const js = scripts.join('\n');
		for (const token of ['renderAccounts', 'renderAccountDetail', 'focusAccount', 'toggleAccount', 'refreshAccount', 'connectAccount', 'manageAccounts']) {
			expect(js, token).toContain(token);
		}
	});

	it('CSP：脚本与样式全部携带 nonce，无内联 style 属性', () => {
		const nonceMatch = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(html);
		expect(nonceMatch).toBeTruthy();
		const nonce = nonceMatch![1];
		expect(html).toContain(`<style nonce="${nonce}">`);
		expect(html).toContain(`<script nonce="${nonce}">`);
		// 标记部分（脚本之前）不允许内联 style 属性（CSP style-src 仅 nonce）
		const markup = html.slice(0, html.indexOf('<script'));
		expect(markup).not.toContain('style="');
		expect(html).toContain(`default-src 'none'`);
	});

	it('包含账户区、管理入口与数据消息钩子', () => {
		expect(html).toContain('账户与套餐');
		expect(html).toContain('id="accounts"');
		expect(html).toContain('data-msg="manageAccounts"');
		expect(html).toContain('aria-label="管理账户连接"');
	});

	it('“打开用量总览”按钮置于顶部（hero 之前）且仅一处', () => {
		const btnIdx = html.indexOf('data-msg="openOverview"');
		expect(btnIdx).toBeGreaterThan(-1);
		expect(btnIdx).toBeLessThan(html.indexOf('id="hero"'));
		expect(html.indexOf('data-msg="openOverview"', btnIdx + 1)).toBe(-1); // 底部不再重复
	});

	it('渲染宿主端数据集合（accounts / accountDetail / accountExpanded）', () => {
		expect(html).toContain('data.accounts || []');
		expect(html).toContain('data.accountDetail');
		expect(html).toContain('data.accountExpanded');
		expect(html).toContain("msg.type === 'focusAccount'");
	});
});
