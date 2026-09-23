/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Sidebar "账户与套餐" view model — pure functions producing the exact row and
 * detail strings the webview renders. Kept host-side so the webview stays a
 * dumb renderer and everything here is unit-tested.
 */

import type { AccountProviderDef } from './providerRegistry';
import type { AccountSnapshot, AccountViewState } from './types';
import { sanitizeErrorMessage } from './sanitize';
import { formatPercent, formatRelativeTime, windowDetailLine } from './windowSelection';

export interface AccountRowModel {
	id: string;
	name: string;
	mode: string;
	line2: string;
	connected: boolean;
	current: boolean;
}

export interface AccountDetailModel {
	provider: string;
	rows: Array<{ label: string; value: string }>;
	stale: string;
}

export interface LocalProviderTotals {
	tokens: number;
	costCny: number;
}

/** Brand-ish mode label — small factual map, not provider branching logic. */
const PLAN_LABELS: Record<string, string> = { glm: 'Coding Plan', qwen: 'Token Plan' };

export function accountModeLabel(providerId: string, snapshot: AccountSnapshot | null): string {
	if (!snapshot) { return '—'; }
	if (snapshot.billingMode === 'payg') { return '按量'; }
	return snapshot.plan?.name ?? PLAN_LABELS[providerId] ?? '套餐';
}

/** Two-line row: mode tag + compact usage line. */
export function accountCompactLine(snapshot: AccountSnapshot | null): string {
	if (!snapshot) { return ''; }
	const parts: string[] = [];
	for (const window of snapshot.windows.slice(0, 2)) {
		if (window.remainingPercent !== undefined) {
			parts.push(`${window.label} ${formatPercent(window.remainingPercent)}`);
		}
	}
	if (snapshot.balance) {
		const symbol = snapshot.balance.currency === 'CNY' ? '¥' : `${snapshot.balance.currency} `;
		parts.push(`余额 ${symbol}${snapshot.balance.value.toFixed(2)}`);
	}
	return parts.join(' · ');
}

export function buildAccountRow(def: AccountProviderDef, state: AccountViewState, current: boolean): AccountRowModel {
	const snapshot = state.cached?.snapshot ?? null;
	if (!state.connected) {
		return { id: def.id, name: def.displayName, mode: '未连接', line2: '点击连接', connected: false, current };
	}
	if (!snapshot) {
		const kind = state.cached?.lastError?.kind;
		const line2 = kind === 'unauthorized' ? '需要重新连接'
			: kind === 'noPlan' ? '按量计费 · 无套餐额度'
			: kind ? '刷新失败 · 点击重试'
			: '等待首次读取';
		return { id: def.id, name: def.displayName, mode: kind === 'noPlan' ? '按量' : '—', line2, connected: true, current };
	}
	return {
		id: def.id,
		name: def.displayName,
		mode: accountModeLabel(def.id, snapshot),
		line2: accountCompactLine(snapshot) || '已连接',
		connected: true,
		current,
	};
}

export function buildAccountDetail(
	providerId: string,
	state: AccountViewState,
	local: LocalProviderTotals | null,
	now: number,
): AccountDetailModel | null {
	if (!state.connected) { return null; }
	const snapshot = state.cached?.snapshot ?? null;
	const rows: Array<{ label: string; value: string }> = [];
	if (snapshot) {
		for (const window of snapshot.windows) {
			rows.push({ label: '额度', value: windowDetailLine(window, now) });
		}
		if (snapshot.plan?.name) {
			rows.push({ label: '套餐', value: snapshot.plan.name });
		}
		if (snapshot.balance) {
			const symbol = snapshot.balance.currency === 'CNY' ? '¥' : `${snapshot.balance.currency} `;
			let value = `${symbol}${snapshot.balance.value.toFixed(2)}`;
			const breakdown = snapshot.balance.breakdown;
			if (breakdown && (breakdown.granted !== undefined || breakdown.toppedUp !== undefined)) {
				const bits: string[] = [];
				if (breakdown.granted !== undefined) { bits.push(`赠金 ${symbol}${breakdown.granted.toFixed(2)}`); }
				if (breakdown.toppedUp !== undefined) { bits.push(`充值 ${symbol}${breakdown.toppedUp.toFixed(2)}`); }
				if (bits.length > 0) { value += `（${bits.join(' · ')}）`; }
			}
			// Qwen's balance always comes from the Aliyun account (BSS) — say so,
			// never present it as a “Qwen standalone balance”.
			rows.push({ label: providerId === 'qwen' ? '余额（阿里云账户）' : '余额', value });
		}
	}
	if (local) {
		rows.push({ label: '本地 Token（近 7 天）', value: formatLocalTokens(local.tokens) });
		rows.push({ label: '等效 API 成本（近 7 天）', value: `≈ ¥${local.costCny.toFixed(2)}（按官方按量价换算，不代表套餐扣款）` });
	}
	if (snapshot) {
		rows.push({ label: '数据来源', value: snapshot.source === 'official-api' ? '官方 API' : '官方控制台' });
	}
	rows.push({ label: '更新时间', value: formatRelativeTime(state.cached?.updatedAt ?? 0, now) });

	let stale = '';
	const error = state.cached?.lastError;
	if (error && error.at > (state.cached?.updatedAt ?? 0)) {
		if (error.kind === 'noPlan') {
			stale = `未检测到套餐订阅（${formatRelativeTime(error.at, now)}）`;
			rows.push({
				label: '说明',
				value: providerId === 'qwen'
					? '该账号按量计费；如需显示阿里云账户余额，可在“管理账户”中绑定阿里云 AccessKey'
					: '该账号按量计费，官方未提供套餐额度；余额请在对应控制台查看',
			});
		} else {
			stale = error.kind === 'unauthorized'
				? `需要重新连接（${formatRelativeTime(error.at, now)}）`
				: `刷新失败（${formatRelativeTime(error.at, now)}）`;
			// Show the official reason (already sanitized) so users can tell an
			// account-level refusal from a hiccup.
			if (error.message) {
				rows.push({ label: '最近错误', value: sanitizeErrorMessage(error.message).slice(0, 160) });
			}
		}
	}
	return { provider: providerId, rows, stale };
}

function formatLocalTokens(tokens: number): string {
	if (tokens >= 1_000_000) { return `${(tokens / 1_000_000).toFixed(2)}M`; }
	if (tokens >= 1_000) { return `${(tokens / 1_000).toFixed(1)}K`; }
	return String(tokens);
}
