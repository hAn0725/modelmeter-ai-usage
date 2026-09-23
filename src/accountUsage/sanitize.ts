/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Credential hygiene helpers, shared by the account service, the status-bar
 * model and the sidebar view model. No `vscode` import — pure and unit-tested.
 */

/** Strip anything credential-shaped from error text before it can reach logs / UI. */
export function sanitizeErrorMessage(message: string): string {
	return message
		.replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
		.replace(/(authorization|cookie|x-api-key|api[-_]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=***')
		.slice(0, 200);
}
