/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Namespace consistency — package.json contributions vs. source registrations.
 *
 * Prevents “dead IDs”: every contributed command must be registered, every
 * contributed configuration key must exist in the new `modelMeter.*` namespace,
 * view ids must match the webview registrations, and no source file (other than
 * the intentional legacy-compat modules) may still reference the old prefix.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';

// vitest 以项目根目录为 cwd 运行，这里直接用 cwd 避免 import.meta（tsconfig 为 CommonJS）
const root = process.cwd();
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
	activationEvents: string[];
	contributes: {
		viewsContainers: { activitybar: Array<{ id: string }> };
		views: Record<string, Array<{ id: string; type: string }>>;
		commands: Array<{ command: string }>;
		menus: Record<string, Array<{ command: string; when?: string }>>;
		configuration: { properties: Record<string, unknown> };
	};
};

function sourceFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const p = path.join(dir, entry);
		if (statSync(p).isDirectory()) { out.push(...sourceFiles(p)); }
		else if (p.endsWith('.ts')) { out.push(p); }
	}
	return out;
}

describe('namespace：package.json 与源码一致性', () => {
	it('所有 contributed 命令均为 modelMeter.* 且全局唯一', () => {
		const ids = pkg.contributes.commands.map(c => c.command);
		expect(ids.length).toBeGreaterThanOrEqual(16);
		const seen = new Set<string>();
		for (const id of ids) {
			expect(id.startsWith('modelMeter.')).toBe(true);
			expect(seen.has(id)).toBe(false);
			seen.add(id);
		}
	});

	it('每个 contributed 命令都有 registerCommand 注册（extension.ts / nodeActions.ts）', () => {
		const registered = new Set<string>();
		for (const file of ['src/extension.ts', 'src/tree/nodeActions.ts']) {
			const text = readFileSync(path.join(root, file), 'utf8');
			for (const m of text.matchAll(/registerCommand\('([^']+)'/g)) { registered.add(m[1]); }
		}
		for (const { command } of pkg.contributes.commands) {
			expect(registered.has(command), `未注册的命令: ${command}`).toBe(true);
		}
	});

	it('menus 引用的命令全部在 contributed 列表中（无悬空引用）', () => {
		const ids = new Set(pkg.contributes.commands.map(c => c.command));
		for (const [menu, entries] of Object.entries(pkg.contributes.menus)) {
			for (const entry of entries) {
				expect(ids.has(entry.command), `${menu} 中的悬空命令: ${entry.command}`).toBe(true);
				if (entry.when?.includes('view ==')) {
					expect(entry.when).toContain('view == modelMeter.main');
				}
			}
		}
	});

	it('configuration 4 个键均为 modelMeter.*，activationEvents/视图 ID 已独立', () => {
		const keys = Object.keys(pkg.contributes.configuration.properties);
		expect(keys.sort()).toEqual([
			'modelMeter.logLevel',
			'modelMeter.tokenUsage.backfillDays',
			'modelMeter.tokenUsage.usdToCnyRate',
			'modelMeter.tokenUsage.watcherWindowDays',
		]);
		expect(pkg.activationEvents).toContain('onView:modelMeter.main');
		expect(pkg.activationEvents).toContain('onStartupFinished');
		expect(pkg.contributes.viewsContainers.activitybar[0].id).toBe('modelMeter');
		expect(pkg.contributes.views['modelMeter']).toBeDefined();
		expect(pkg.contributes.views['modelMeter'][0]).toMatchObject({ type: 'webview', id: 'modelMeter.main' });
	});

	it('面板 viewType 均为 modelMeter.overview/vendor/model/session', () => {
		const files: Record<string, string> = {
			'overview': 'src/tokenUsage/tokenUsageDashboard.ts',
			'vendor': 'src/tokenUsage/vendorDashboard.ts',
			'model': 'src/tokenUsage/modelDashboard.ts',
			'session': 'src/tokenUsage/sessionDashboard.ts',
		};
		for (const [name, file] of Object.entries(files)) {
			const text = readFileSync(path.join(root, file), 'utf8');
			expect(text).toContain(`viewType = 'modelMeter.${name}'`);
		}
	});

	it('除 legacyConfig.ts 与 extension.ts（兼容读取/迁移）外，源码不再出现旧前缀', () => {
		const allowlist = new Set([
			path.join(root, 'src', 'tokenUsage', 'legacyConfig.ts'),
			path.join(root, 'src', 'extension.ts'),
			path.join(root, 'src', 'test', 'namespace.spec.ts'),
			path.join(root, 'src', 'test', 'legacyConfig.spec.ts'),
		]);
		const offenders: string[] = [];
		for (const file of sourceFiles(path.join(root, 'src'))) {
			if (allowlist.has(file)) { continue; }
			const text = readFileSync(file, 'utf8');
			if (text.includes('copilotAlternatives')) { offenders.push(path.relative(root, file)); }
		}
		expect(offenders).toEqual([]);
	});

	it('侧边栏视图注册与 package.json 一致（modelMeter.main）', () => {
		const text = readFileSync(path.join(root, 'src/extension.ts'), 'utf8');
		expect(text).toContain("registerWebviewViewProvider('modelMeter.main'");
		expect(text).toContain("'workbench.view.extension.modelMeter'");
	});
});
