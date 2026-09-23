/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider registry — the only place that knows which providers exist, how
 * they authenticate, and (for browser-login providers) where the user logs in.
 *
 * UI code iterates this registry; it must never branch on provider ids
 * directly.
 */

import type { AccountProviderId } from './types';

export interface AccountRegionDef {
	id: string;
	label: string;
	/** Region-specific sign-in page (falls back to the provider-level loginUrl). */
	loginUrl?: string;
}

export interface ProviderLoginMeta {
	/** Page the user signs in on when no region-specific URL applies. */
	loginUrl: string;
	/** Cookie domains read after login. */
	domains: string[];
	/**
	 * Cookies that must be present for the session to be considered usable.
	 * Empty when the provider cannot name them reliably — then the caller
	 * provides a `verify` callback instead (Qwen verifies by calling
	 * user/info.json, the same endpoint its API uses).
	 */
	cookieNames: string[];
}

export interface AccountProviderDef {
	id: AccountProviderId;
	displayName: string;
	/** Credential kind the user must supply. */
	credential: 'apiKey' | 'cookie';
	/** Present when the provider has region-specific endpoints (minimal pick). */
	regions?: AccountRegionDef[];
	/** Present for cookie providers — powers BrowserLoginService + manual fallback. */
	login?: ProviderLoginMeta;
}

export const ACCOUNT_PROVIDERS: readonly AccountProviderDef[] = [
	{
		id: 'deepseek',
		displayName: 'DeepSeek',
		credential: 'apiKey',
	},
	{
		id: 'glm',
		displayName: 'GLM',
		credential: 'apiKey',
		regions: [
			{ id: 'global', label: '国际（z.ai）' },
			{ id: 'cn', label: '中国大陆（BigModel）' },
		],
	},
	{
		id: 'qwen',
		displayName: 'Qwen',
		credential: 'cookie',
		regions: [
			{ id: 'cn', label: '中国大陆（百炼）', loginUrl: 'https://bailian.console.aliyun.com/' },
			{ id: 'intl', label: '国际（Qwen Cloud）', loginUrl: 'https://home.qwencloud.com/' },
		],
		login: {
			// cn signs in at the Bailian console; intl at Qwen Cloud (the path
			// both reference implementations drive). Success is decided by the
			// provider's own user/info.json verify call — the console's cookie
			// names vary across the ONE_CONSOLE family generations, so name
			// matching is deliberately not used here.
			loginUrl: 'https://home.qwencloud.com/',
			domains: [
				'https://home.qwencloud.com',
				'https://cs-data.qwencloud.com',
				'https://bailian.console.aliyun.com',
				'https://bailian-cs.console.aliyun.com',
			],
			cookieNames: [],
		},
	},
	{
		id: 'mimo',
		displayName: 'MiMo',
		credential: 'cookie',
		login: {
			// Source: Buggo404/mimo-usage-monitor (verified VS Code extension).
			loginUrl: 'https://platform.xiaomimimo.com/console/plan-manage',
			domains: ['https://platform.xiaomimimo.com'],
			cookieNames: ['userId', 'api-platform_slh', 'api-platform_ph'],
		},
	},
];

export function getProviderDef(id: AccountProviderId): AccountProviderDef | undefined {
	return ACCOUNT_PROVIDERS.find(p => p.id === id);
}
