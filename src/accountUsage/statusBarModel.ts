/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * StatusBar model — pure functions so the exact text/tooltip behaviour is
 * unit-testable without a VS Code host.
 *
 * Rules (0.3.0 spec):
 *  - only the provider of the *currently observed* model is shown
 *  - PAYG → `DeepSeek ¥38.62`; plan → `GLM [████░░] 68%` (6-cell remaining bar)
 *  - unknown provider → `ModelMeter` (never guess)
 *  - tooltip: full detail for the current provider, compact 5h/primary line
 *    for the other connected accounts, local equivalent-API cost clearly
 *    marked as such (never mixed with plan quota).
 */

import type { AccountSnapshot } from './types';
import { sanitizeErrorMessage } from './sanitize';
import { STATUS_BAR_CELLS, DETAIL_CELLS, compactAccountSummary, formatPercent, formatProgressBar, formatRelativeTime, selectPrimaryWindow, windowDetailLine } from './windowSelection';

export interface OtherAccountLine {
	name: string;
	snapshot: AccountSnapshot | null;
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
	others: OtherAccountLine[];
	now: number;
}

export function buildStatusBarText(input: StatusBarInput): string {
	const flame = '$(flame)';
	if (!input.providerName) {
		return `${flame} ModelMeter`;
	}
	if (!input.connected || !input.snapshot) {
		return `${flame} ${input.providerName}`;
	}
	const primary = selectPrimaryWindow(input.snapshot);
	if (primary && primary.remainingPercent !== undefined) {
		return `${flame} ${input.providerName} [${formatProgressBar(primary.remainingPercent, STATUS_BAR_CELLS)}] ${formatPercent(primary.remainingPercent)}`;
	}
	if (input.snapshot.balance) {
		const currency = input.snapshot.balance.currency || 'CNY';
		const symbol = currency === 'CNY' ? '¥' : `${currency} `;
		return `${flame} ${input.providerName} ${symbol}${input.snapshot.balance.value.toFixed(2)}`;
	}
	return `${flame} ${input.providerName}`;
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
