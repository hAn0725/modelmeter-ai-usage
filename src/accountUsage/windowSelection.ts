/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure view-model helpers shared by the StatusBar and the Sidebar account
 * section: progress bars, primary-window selection, and compact summary lines.
 *
 * Everything here renders REMAINING percentages (never "used"), clamps
 * defensively, and never mixes account quota with local equivalent-API cost.
 */

import type { AccountSnapshot, AccountWindow } from './types';

/** Render `pct` (remaining, 0–100) as a filled/empty bar of `cells` blocks. */
export function formatProgressBar(remainingPercent: number, cells: number): string {
	const clamped = Math.max(0, Math.min(100, Number.isFinite(remainingPercent) ? remainingPercent : 0));
	const filled = Math.round((clamped / 100) * cells);
	return '█'.repeat(filled) + '░'.repeat(Math.max(0, cells - filled));
}

export const STATUS_BAR_CELLS = 6;
export const DETAIL_CELLS = 10;

/**
 * The window the StatusBar shows. Providers emit windows already ordered by
 * priority (5h first); this picks the 5h window when present, then the first
 * window that carries a remaining percentage.
 */
export function selectPrimaryWindow(snapshot: AccountSnapshot | null | undefined): AccountWindow | undefined {
	const windows = snapshot?.windows ?? [];
	return windows.find(w => w.id === '5h' && w.remainingPercent !== undefined)
		?? windows.find(w => w.remainingPercent !== undefined);
}

/** First 5h window for the compact "other accounts" lines. */
export function selectFiveHourWindow(snapshot: AccountSnapshot | null | undefined): AccountWindow | undefined {
	return (snapshot?.windows ?? []).find(w => w.id === '5h' && w.remainingPercent !== undefined);
}

export function formatPercent(remainingPercent: number): string {
	return `${Math.round(Math.max(0, Math.min(100, remainingPercent)))}%`;
}

export function formatBalance(snapshot: AccountSnapshot): string | null {
	if (!snapshot.balance) { return null; }
	const currency = snapshot.balance.currency || 'CNY';
	const symbol = currency === 'CNY' ? '¥' : `${currency} `;
	return `${symbol}${snapshot.balance.value.toFixed(2)}`;
}

/**
 * One compact account line used by StatusBar / Sidebar "other accounts" /
 * sidebar rows:
 *   plan with 5h  → `[████░░] 68%`
 *   other plan    → `[████░░] 73%` (primary window)
 *   payg          → `¥38.62`
 */
export function compactAccountSummary(snapshot: AccountSnapshot | null | undefined, cells = STATUS_BAR_CELLS): string | null {
	if (!snapshot) { return null; }
	const primary = selectPrimaryWindow(snapshot);
	if (primary && primary.remainingPercent !== undefined) {
		return `[${formatProgressBar(primary.remainingPercent, cells)}] ${formatPercent(primary.remainingPercent)}`;
	}
	return formatBalance(snapshot);
}

/** Long-form window rows for detail views: `5h   [████████░░] 68% 剩余 · 重置 14:32`. */
export function windowDetailLine(window: AccountWindow, now: number, cells = DETAIL_CELLS): string {
	if (window.remainingPercent === undefined) { return `${window.label}`; }
	let line = `${window.label}  [${formatProgressBar(window.remainingPercent, cells)}] ${formatPercent(window.remainingPercent)} 剩余`;
	if (window.resetAt) {
		const when = new Date(window.resetAt);
		const sameDay = new Date(now).toDateString() === when.toDateString();
		const stamp = `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`;
		line += ` · 重置 ${sameDay ? '' : `${when.getMonth() + 1}/${when.getDate()} `}${stamp}`;
	}
	return line;
}

/** `22 分钟前` / `刚刚` / `3 小时前` for "updated at" annotations. */
export function formatRelativeTime(at: number, now: number): string {
	if (!at) { return '从未更新'; }
	const delta = Math.max(0, now - at);
	if (delta < 60_000) { return '刚刚'; }
	const minutes = Math.floor(delta / 60_000);
	if (minutes < 60) { return `${minutes} 分钟前`; }
	const hours = Math.floor(minutes / 60);
	if (hours < 48) { return `${hours} 小时前`; }
	return `${Math.floor(hours / 24)} 天前`;
}
