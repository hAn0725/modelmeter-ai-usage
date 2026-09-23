/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared option types for provider adapters.
 */

import type { FetchLike } from '../http';
import type { AliyunAccessKey } from '../aliyunBss';

export interface ProviderFetchOptions {
	/** Injectable HTTP implementation (tests never hit the network). */
	fetchImpl?: FetchLike;
	/** Region id for providers with region-specific endpoints (glm / qwen). */
	region?: string;
	/** Injectable clock. */
	now?: number;
	/** Injectable timeout. */
	timeoutMs?: number;
	/** Injectable UUID (qwen trace ids). */
	randomUUID?: () => string;
	/** Qwen only: optional Aliyun RAM AccessKey for the account-balance fallback. */
	aliyunAccessKey?: AliyunAccessKey;
}
