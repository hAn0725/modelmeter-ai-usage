/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest';

// No vscode mock needed — vendorResolver is pure logic with no VS Code dependencies
import { resolveVendor } from '../tokenUsage/vendorResolver';
import { formatVendorName, canonicalModelName } from '../tokenUsage/vendorDisplay';

describe('vendorResolver', () => {
	// ── Prefix from model ID ──────────────────────────────────────────

	it('extracts vendor from model ID prefix before /', () => {
		expect(resolveVendor('feima/deepseek-v4-pro')).toBe('feima');
		expect(resolveVendor('copilot/claude-sonnet-4.6')).toBe('copilot');
		expect(resolveVendor('customendpoint/BytePlus/deepseek-v4-flash')).toBe('customendpoint');
		expect(resolveVendor('openai/gpt-4o')).toBe('openai');
		expect(resolveVendor('azure/gpt-4o')).toBe('azure');
	});

	// ── Heuristic fallback ───────────────────────────────────────────

	it('falls back to heuristic for model names without prefix', () => {
		expect(resolveVendor('claude-sonnet-4.6')).toBe('anthropic');
		expect(resolveVendor('claude-opus-4')).toBe('anthropic');
		expect(resolveVendor('gpt-4o-mini-2024-07-18')).toBe('openai');
		expect(resolveVendor('gpt-4o')).toBe('openai');
		expect(resolveVendor('gemini-2.5-pro')).toBe('google');
		expect(resolveVendor('gemini-flash')).toBe('google');
		expect(resolveVendor('deepseek-v4-pro')).toBe('deepseek');
		expect(resolveVendor('glm-5.1')).toBe('zhipu');
		expect(resolveVendor('glm-5')).toBe('zhipu');
		expect(resolveVendor('kimi-k3')).toBe('moonshot');
		expect(resolveVendor('kimi-k2.7-code')).toBe('moonshot');
		expect(resolveVendor('moonshot-v1-128k')).toBe('moonshot');
		expect(resolveVendor('ernie-5.1')).toBe('baidu');
	});

	it('returns unknown for unrecognized models', () => {
		expect(resolveVendor('some-unknown-model')).toBe('unknown');
		expect(resolveVendor('')).toBe('unknown');
	});

	// ── Xiaomi MiMo (real BYOK provider: vendor "mimo") ────────────────

	it('resolves the Xiaomi MiMo vendor from prefix or heuristic', () => {
		// Real identifiers observed in chatSessions (vendor `mimo`, extension sdmapvstool.xiaomimimo-for-copilot)
		expect(resolveVendor('mimo/mimo-v2.6-flash')).toBe('mimo');
		expect(resolveVendor('mimo/mimo-v2.6-pro')).toBe('mimo');
		expect(resolveVendor('mimo/mimo-v2.6-pro-ultraspeed')).toBe('mimo');
		// Heuristic fallback for unprefixed names
		expect(resolveVendor('mimo-v2.6-flash')).toBe('mimo');
		expect(resolveVendor('xiaomi-mimo-v2.6-pro')).toBe('mimo');
	});

	it('formats vendor display names consistently (raw vendor ids in DB, pretty in UI)', () => {
		expect(formatVendorName('mimo')).toBe('MiMo');
		expect(formatVendorName('xiaomi')).toBe('MiMo');
		expect(formatVendorName('deepseek')).toBe('DeepSeek');
		expect(formatVendorName('glm')).toBe('GLM');
		expect(formatVendorName('Qwen')).toBe('Qwen');
		// customendpoint provider names pass through unchanged
		expect(formatVendorName('Nova')).toBe('Nova');
		expect(formatVendorName('RedNotes Dots AI')).toBe('RedNotes Dots AI');
		expect(formatVendorName(null)).toBe('未知');
	});

	it('canonical model names keep the real official id without the vendor prefix', () => {
		expect(canonicalModelName('mimo/mimo-v2.6-flash')).toBe('mimo-v2.6-flash');
		expect(canonicalModelName('customendpoint/Nova/glm-5.2')).toBe('glm-5.2');
		expect(canonicalModelName('deepseek-flash')).toBe('deepseek-flash');
		expect(canonicalModelName(null)).toBe('未知');
	});

	// ── Prefix takes priority over heuristic ─────────────────────────

	it('prefix takes priority over heuristic when both apply', () => {
		// Even though "claude" heuristically maps to "anthropic",
		// the prefix "feima/" takes priority
		expect(resolveVendor('feima/claude-sonnet-4.6')).toBe('feima');
		expect(resolveVendor('feima/deepseek-v4-pro')).toBe('feima');
	});
});
