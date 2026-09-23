/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Credential storage for account providers.
 *
 * ONLY VS Code SecretStorage is used for API keys / cookies / tokens.
 * Nothing secret may ever reach settings.json, SQLite, globalState, logs or
 * exports. Loggers may only ever see `configured / not configured`.
 */

import type { AccountProviderId } from './types';

export interface SecretStorageLike {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

export const SECRET_KEY_PREFIX = 'modelMeter.account.';

/** `aliyunAk` stores a JSON {id, secret} pair (Qwen balance fallback). */
export type CredentialSlot = 'key' | 'cookie' | 'aliyunAk';

export function secretKey(provider: AccountProviderId, kind: CredentialSlot): string {
	return `${SECRET_KEY_PREFIX}${provider}.${kind}`;
}

export type CredentialKind = 'apiKey' | 'cookie' | 'none';

export class AccountCredentialStore {
	constructor(private readonly _secrets: SecretStorageLike) { }

	async get(provider: AccountProviderId, kind: CredentialSlot): Promise<string | undefined> {
		const value = await this._secrets.get(secretKey(provider, kind));
		return value && value.trim() ? value : undefined;
	}

	async set(provider: AccountProviderId, kind: CredentialSlot, value: string): Promise<void> {
		await this._secrets.store(secretKey(provider, kind), value.trim());
	}

	async delete(provider: AccountProviderId, kind: CredentialSlot): Promise<void> {
		await this._secrets.delete(secretKey(provider, kind));
	}

	/** Which credential kind (if any) this provider currently has stored. */
	async describe(provider: AccountProviderId, expected: 'apiKey' | 'cookie'): Promise<CredentialKind> {
		const kind = expected === 'apiKey' ? 'key' : 'cookie';
		return (await this.get(provider, kind)) ? expected : 'none';
	}
}
