/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/** Provider id → fetch implementation (the single wiring point). */

import type { AccountProviderId, AccountSnapshot } from './types';
import type { ProviderFetchOptions } from './providers/shared';
import { fetchDeepSeekSnapshot } from './providers/deepseek';
import { fetchGlmSnapshot } from './providers/glm';
import { fetchQwenSnapshot } from './providers/qwen';
import { fetchMimoSnapshot } from './providers/mimo';

export type ProviderFetcher = (credential: string, options: ProviderFetchOptions) => Promise<AccountSnapshot>;

export const PROVIDER_FETCHERS: Record<AccountProviderId, ProviderFetcher> = {
	deepseek: fetchDeepSeekSnapshot,
	glm: fetchGlmSnapshot,
	qwen: fetchQwenSnapshot,
	mimo: fetchMimoSnapshot,
};
