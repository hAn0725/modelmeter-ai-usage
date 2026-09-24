/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * StatusBar model — pure functions so the exact text/tooltip behaviour is
 * unit-testable without a VS Code host.
 *
 * Rules (0.4.0):
 *  - only the provider of the *currently observed* model is shown; unknown →
 *    `ModelMeter` (never guess)
 *  - the text is one line: provider · 本轮 tokens · output speed · equivalent
 *    cost · official balance (plan accounts without a balance fall back to the
 *    primary quota bar) — every segment is optional and self-describing
 *  - tooltip: active-conversation detail, full account detail for the current
 *    provider, compact lines for other connected accounts, and honest wording
 *    that the equivalent API cost never represents plan billing.
 */

import type { AccountSnapshot } from './types';
import { sanitizeErrorMessage } from './sanitize';
import { STATUS_BAR_CELLS, DETAIL_CELLS, compactAccountSummary, formatPercent, formatProgressBar, formatRelativeTime, selectPrimaryWindow, windowDetailLine } from './windowSelection';

export interface OtherAccountLine {
	name: string;
	snapshot: AccountSnapshot | null;
}

/** Active (latest) conversation metrics — local database facts. */
export interface ActiveSessionInput {
	turns: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	/** Output speed (completion tokens per second); null when unavailable. */
	outputTps: number | null;
	costCny: number;
	/** True when any turn of the session has no official price. */
	unpriced: boolean;
}

export interface StatusBarInput {
	/** Display name of the provider behind the currently observed model (null = unknown). */
	providerName: string | null;
	/** The most recently observed model id (for the tooltip). */
	currentModel: string | null;
	connected: boolean;
	snapshot: AccountSnapshot | null;
	lastError: { kind: string; message: string; at: number } | null;
	/** Last successful fetch (0 = never). */
	updatedAt: number;
	/** Local equivalent-API cost for the current provider, last 7 days (≈). */
	localCostCny: number | null;
	localTokens: number | null;
	/** Active (latest) conversation metrics (null = no completed turns yet). */
	session: ActiveSessionInput | null;
	others: OtherAccountLine[];
	now: number;
}

/** Same compact style as the sidebar hero (`12.3K` / `1.23M`). */
export function compactTokens(n: number): string {
	if (n >= 1_000_000) { return `${(n / 1_000_000).toFixed(2)}M`; }
	if (n >= 1_000) { return `${(n / 1_000).toFixed(1)}K`; }
	return String(Math.round(n));
}

function formatCostAmount(cny: number): string {
	return cny > 0 && cny < 0.005 ? '<0.01' : cny.toFixed(2);
}

export function buildStatusBarText(input: StatusBarInput): string {
	const flame = '$(flame)';
	if (!input.providerName) {
		return `${flame} ModelMeter`;
	}
	const parts: string[] = [input.providerName];

	// 本轮对话（本地统计）：tokens / 输出速度 / 等效成本
	const session = input.session;
	if (session && session.totalTokens > 0) {
		parts.push(`本轮 ${compactTokens(session.totalTokens)}`);
		if (session.outputTps !== null && session.outputTps > 0) {
			parts.push(`${Math.round(session.outputTps)} tok/s`);
		}
		if (!(session.unpriced && session.costCny === 0)) {
			parts.push(`≈¥${formatCostAmount(session.costCny)}`);
		}
	}

	// 账户额度：余额优先；无余额的套餐回退到主进度条
	if (input.connected && input.snapshot) {
		if (input.snapshot.balance) {
			const currency = input.snapshot.balance.currency || 'CNY';
			const symbol = currency === 'CNY' ? '¥' : `${currency} `;
			parts.push(`余额 ${symbol}${input.snapshot.balance.value.toFixed(2)}`);
		} else {
			const primary = selectPrimaryWindow(input.snapshot);
			if (primary && primary.remainingPercent !== undefined) {
				parts.push(`[${formatProgressBar(primary.remainingPercent, STATUS_BAR_CELLS)}] ${formatPercent(primary.remainingPercent)}`);
			}
		}
	}
	return `${flame} ${parts.join(' · ')}`;
}

function otherLine(line: OtherAccountLine): string {
	const compact = compactAccountSummary(line.snapshot, DETAIL_CELLS);
	return `${line.name}   ${compact ?? '未连接'}`;
}

export function buildStatusBarTooltip(input: StatusBarInput): string {
	const lines: string[] = ['**ModelMeter**', ''];
	if (input.currentModel) {
		lines.push(`当前模型 ${input.currentModel}`, '');
	}
	// 当前会话（本地统计）
	const session = input.session;
	if (session && session.totalTokens > 0) {
		lines.push('当前会话（本地统计）');
		lines.push(`  ${session.turns} 轮 · 合计 ${compactTokens(session.totalTokens)}（输入 ${compactTokens(session.promptTokens)} / 输出 ${compactTokens(session.completionTokens)}）`);
		if (session.outputTps !== null && session.outputTps > 0) {
			lines.push(`  输出速度 ≈ ${session.outputTps.toFixed(1)} tok/s`);
		}
		if (!(session.unpriced && session.costCny === 0)) {
			lines.push(`  等效 API 成本 ≈ ¥${session.costCny.toFixed(2)}${session.unpriced ? '（部分模型无价格，为下限）' : ''}`);
		} else {
			lines.push('  等效 API 成本：暂无价格数据');
		}
		lines.push('  按本地捕获的 Token 与官方按量单价换算，不代表套餐实际扣款', '');
	}
	if (!input.providerName) {
		lines.push('未能识别当前模型对应的官方账户。', '');
	} else if (!input.connected) {
		lines.push(`${input.providerName} 账户未连接。`, '点击配置连接。', '');
	} else {
		const snap = input.snapshot;
		const planLabel = snap?.plan?.name ?? (snap?.billingMode === 'plan' ? '订阅套餐' : '按量付费');
		lines.push(`${input.providerName} · ${planLabel}`);
		const windows = snap?.windows ?? [];
		if (windows.length > 0) {
			for (const window of windows) {
				lines.push(windowDetailLine(window, input.now));
			}
		}
		if (snap?.balance) {
			const symbol = snap.balance.currency === 'CNY' ? '¥' : `${snap.balance.currency} `;
			lines.push(`余额 ${symbol}${snap.balance.value.toFixed(2)}`);
		}
		lines.push('');
		if (input.localCostCny !== null) {
			lines.push(`等效 API 成本（近 7 天）≈ ¥${input.localCostCny.toFixed(2)}`);
			lines.push('按官方按量 API 单价换算；Token Plan 仅代表等效价值，不代表套餐实际扣款');
		}
	}
	const otherLines = input.others.filter(o => o.snapshot !== null);
	if (otherLines.length > 0) {
		lines.push('', '其他账户');
		for (const line of otherLines) {
			lines.push(otherLine(line));
		}
	}
	lines.push('');
	if (input.lastError && input.lastError.at > input.updatedAt) {
		const when = formatRelativeTime(input.lastError.at, input.now);
		if (input.lastError.kind === 'noPlan') {
			lines.push(`○ 该账号未订阅套餐（按量计费，合法状态）`);
		} else if (input.lastError.kind === 'unauthorized') {
			lines.push(`⚠ 需要重新连接（${when}）`);
			if (input.lastError.message) {
				lines.push(sanitizeErrorMessage(input.lastError.message).slice(0, 140));
			}
		} else {
			lines.push(`⚠ 刷新失败（${when}）`);
			if (input.lastError.message) {
				lines.push(sanitizeErrorMessage(input.lastError.message).slice(0, 140));
			}
		}
	}
	lines.push(`更新于 ${formatRelativeTime(input.updatedAt, input.now)}`);
	if (!input.connected) {
		lines.push('点击打开 ModelMeter 侧边栏 · 账户与套餐');
	} else {
		lines.push('点击打开 ModelMeter 侧边栏 · 账户与套餐');
	}
	return lines.join('\n');
}
