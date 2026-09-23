/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * User-facing display names for vendor identifiers.
 *
 * The data layer stores raw vendor ids (e.g. `mimo`, `deepseek`, `glm`) exactly
 * as reported by VS Code / model extensions. Every UI surface formats through
 * `formatVendorName()` so the same vendor is spelled consistently (e.g. the
 * Xiaomi `mimo` vendor is always shown as "MiMo").
 */

const VENDOR_DISPLAY: Record<string, string> = {
	mimo: 'MiMo',
	xiaomi: 'MiMo',
	deepseek: 'DeepSeek',
	glm: 'GLM',
	zhipu: '智谱',
	qwen: 'Qwen',
	anthropic: 'Anthropic',
	openai: 'OpenAI',
	google: 'Google',
	moonshot: 'Moonshot',
	copilot: 'GitHub Copilot',
	unknown: '未知',
};

/** Formats a raw vendor id for display. Unknown vendors pass through unchanged. */
export function formatVendorName(vendor: string | null | undefined): string {
	if (!vendor) { return '未知'; }
	return VENDOR_DISPLAY[vendor.toLowerCase()] ?? vendor;
}

/**
 * Canonical short model name from a full model id.
 * Example: `"mimo/mimo-v2.6-flash"` → `"mimo-v2.6-flash"`.
 */
export function canonicalModelName(modelId: string | null | undefined): string {
	if (!modelId) { return '未知'; }
	const segments = modelId.split('/');
	return segments[segments.length - 1] || modelId;
}
