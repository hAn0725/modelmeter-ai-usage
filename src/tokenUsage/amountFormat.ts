/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * UI-only CNY amount formatting.
 *
 * Display rules (no effect on stored values or pricing logic):
 *  - 0            → `¥0`
 *  - 0 < cost < ¥0.01 → up to 4 decimals (trailing zeros trimmed; values that
 *                       round to 0 at 4dp collapse to `¥0`)
 *  - cost ≥ ¥0.01 → exactly 2 decimals
 *
 * `formatCnyTiny` is the tooltip variant that keeps up to 4 decimals for tiny
 * amounts without trimming (used where the user is inspecting a precise value).
 */

function trimZeros(s: string): string {
	return s.replace(/0+$/, '').replace(/\.$/, '');
}

/** Standard UI formatting for a CNY amount already in ¥. */
export function formatCnyUi(cny: number): string {
	if (!Number.isFinite(cny) || cny === 0) { return '¥0'; }
	const sign = cny < 0 ? '-' : '';
	const abs = Math.abs(cny);
	if (abs < 0.01) {
		const trimmed = trimZeros(abs.toFixed(4));
		return trimmed === '0' ? '¥0' : `${sign}¥${trimmed}`;
	}
	return `${sign}¥${abs.toFixed(2)}`;
}

/** Chart axis formatting — same rules as `formatCnyUi`. */
export function formatCnyAxis(cny: number): string {
	return formatCnyUi(cny);
}

/** Tooltip formatting — keeps up to 4 decimals for sub-cent amounts. */
export function formatCnyTiny(cny: number): string {
	if (!Number.isFinite(cny) || cny === 0) { return '¥0'; }
	const sign = cny < 0 ? '-' : '';
	const abs = Math.abs(cny);
	if (abs < 0.01) { return `${sign}¥${abs.toFixed(4)}`; }
	return `${sign}¥${abs.toFixed(2)}`;
}

/**
 * Browser-side mirror of the formatters above, embedded into dashboard/webview
 * pages (single source of truth so host and webview stay in sync). Exposes
 * `fmtCnyUi`, `fmtCnyAxis` and `fmtCnyTiny` as global functions.
 */
export const AMOUNT_FMT_JS = `
function fmtCnyUi(v) {
  if (!isFinite(v) || v === 0) return '¥0';
  var sign = v < 0 ? '-' : '';
  var a = Math.abs(v);
  if (a < 0.01) {
    var d = a.toFixed(4).replace(/0+$/, '').replace(/\\.$/, '');
    return d === '0' ? '¥0' : sign + '¥' + d;
  }
  return sign + '¥' + a.toFixed(2);
}
function fmtCnyAxis(v) { return fmtCnyUi(v); }
function fmtCnyTiny(v) {
  if (!isFinite(v) || v === 0) return '¥0';
  var sign = v < 0 ? '-' : '';
  var a = Math.abs(v);
  if (a < 0.01) return sign + '¥' + a.toFixed(4);
  return sign + '¥' + a.toFixed(2);
}
`;
