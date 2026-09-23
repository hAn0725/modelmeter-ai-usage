/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Model-id → account-provider mapping.
 *
 * Reuses the same evidence ModelMeter already trusts (model ids recorded in
 * the local turn database) and keeps the mapping deliberately small and
 * conservative: anything unrecognized returns null and the UI shows
 * "ModelMeter" instead of guessing a provider.
 */

import type { AccountProviderId } from './types';

const MATCHERS: Array<{ provider: AccountProviderId; patterns: RegExp }> = [
	{ provider: 'deepseek', patterns: /deepseek/i },
	{ provider: 'mimo', patterns: /mimo|xiaomimimo|xiaomi/i },
	{ provider: 'glm', patterns: /glm|zhipu|bigmodel|z\.ai|zai(?![a-z])/i },
	{ provider: 'qwen', patterns: /qwen|bailian|dashscope|tongyi/i },
];

export function providerForModel(modelId: string | null | undefined): AccountProviderId | null {
	if (!modelId) { return null; }
	for (const { provider, patterns } of MATCHERS) {
		if (patterns.test(modelId)) { return provider; }
	}
	return null;
}

/**
 * Resolve the "current" provider from the most recent observed model ids
 * (already ordered newest-first). Skips provider-less models; returns null
 * when nothing is confidently recognizable.
 */
export function resolveCurrentProvider(modelIds: readonly string[]): AccountProviderId | null {
	for (const id of modelIds) {
		const provider = providerForModel(id);
		if (provider) { return provider; }
	}
	return null;
}

const VENDOR_MATCHERS: Array<{ provider: AccountProviderId; pattern: RegExp }> = [
	{ provider: 'deepseek', pattern: /deepseek/i },
	{ provider: 'mimo', pattern: /mimo|xiaomi/i },
	{ provider: 'glm', pattern: /glm|zhipu|z\.?ai|bigmodel/i },
	{ provider: 'qwen', pattern: /qwen|bailian|tongyi/i },
];

/** Does a local vendor column value belong to this account provider? */
export function providerVendorMatches(provider: AccountProviderId, vendor: string | null | undefined): boolean {
	if (!vendor) { return false; }
	const matcher = VENDOR_MATCHERS.find(m => m.provider === provider);
	return matcher ? matcher.pattern.test(vendor) : false;
}
