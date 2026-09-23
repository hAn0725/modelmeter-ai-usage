/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** Shared parsing helpers for provider adapters (pure, unit-tested). */

/** Coerce numbers that arrive as numeric strings. */
export function toNumber(value: unknown): number | null {
	if (typeof value === 'number') { return Number.isFinite(value) ? value : null; }
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value.trim());
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** Clamp to 0–100. */
export function clampPercent(value: number): number {
	return Math.max(0, Math.min(100, value));
}

/**
 * Percent fields arrive either as a 0–1 ratio (MiMo, Qwen) or as 0–100
 * (Z.ai percentage). `<= 1 → ratio` is the convention both reference
 * implementations use; a genuine 0–1% value is indistinguishable but harmless
 * at that magnitude.
 */
export function percentPointsFromRatioOrValue(value: unknown, used?: number | null, limit?: number | null): number | null {
	const raw = toNumber(value);
	if (raw === null) {
		if (used !== null && used !== undefined && limit !== null && limit !== undefined && limit > 0) {
			return clampPercent((used / limit) * 100);
		}
		return null;
	}
	const points = raw <= 1 && raw >= 0 ? raw * 100 : raw;
	return clampPercent(points);
}

/**
 * Epoch seconds / epoch milliseconds / `yyyy-MM-dd HH:mm[:ss]` (console local,
 * pinned to UTC+8 like both reference implementations) → epoch ms.
 */
export function toEpochMs(value: unknown): number | undefined {
	const numeric = toNumber(value);
	if (numeric !== null && numeric > 0) {
		return numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
	}
	if (typeof value === 'string' && value.trim()) {
		const text = value.trim();
		const pinned = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text)
			? `${text.replace(' ', 'T')}+08:00`
			: text;
		const parsed = Date.parse(pinned);
		if (!Number.isNaN(parsed)) { return parsed; }
	}
	return undefined;
}

/** First own property matching any of the names, case-insensitive. */
export function pick(obj: unknown, names: string[]): unknown {
	if (!obj || typeof obj !== 'object') { return undefined; }
	const record = obj as Record<string, unknown>;
	for (const name of names) {
		if (name in record && record[name] !== undefined && record[name] !== null) {
			return record[name];
		}
	}
	const lowered = new Map(Object.keys(record).map(k => [k.toLowerCase(), k]));
	for (const name of names) {
		const actual = lowered.get(name.toLowerCase());
		if (actual !== undefined && record[actual] !== undefined && record[actual] !== null) {
			return record[actual];
		}
	}
	return undefined;
}

export function firstNumber(obj: unknown, names: string[]): number | null {
	for (const name of names) {
		const value = toNumber(pick(obj, [name]));
		if (value !== null) { return value; }
	}
	return null;
}

export function firstString(obj: unknown, names: string[]): string {
	for (const name of names) {
		const value = pick(obj, [name]);
		if (typeof value === 'string' && value.trim()) { return value.trim(); }
	}
	return '';
}
