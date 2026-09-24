/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared webview security helpers (0.4.0).
 *
 * VS Code warns ("created a webview without a content security policy") as
 * soon as scripts are enabled while the webview's current document has no CSP
 * meta — including the very first, still-empty document. The reliable order is
 * therefore:
 *
 *   1. `webview.html = <page with CSP meta>`  (scripts still disabled)
 *   2. `webview.options = { enableScripts: true }`
 *
 * Every `content` push is re-rendered with the current options, so enabling
 * scripts afterwards still applies and the inline scripts execute.
 */

/** Cryptographically-random nonce for inline <script>/<style> tags. */
export function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}

/**
 * Strict CSP for webviews that inline their scripts/styles. Each <script>
 * tag must carry `nonce="<nonce>"`; styles stay permissive because the
 * dashboards inline dynamically generated CSS.
 */
export function webviewCsp(nonce: string): string {
	return `default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'`;
}

/** Minimal CSP-carrying document, used to prime a webview before scripts are enabled. */
export function webviewPlaceholder(): string {
	return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
		+ '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'">'
		+ '</head><body></body></html>';
}
