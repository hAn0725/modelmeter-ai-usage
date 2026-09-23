/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Legacy namespace migration — moves user settings from the original
 * `copilotAlternatives.*` namespace to the independent `modelMeter.*`
 * namespace, exactly once, without ever overwriting an explicit new value:
 *
 *  - new key explicitly set (global / workspace / folder) → never touched
 *  - old key explicitly set and new key not → value copied over
 *  - otherwise → nothing happens
 *
 * The migration version is recorded in `globalState` so the planner can be
 * skipped after the first successful run (it stays a no-op regardless).
 */

export const LEGACY_CONFIG_MAP: ReadonlyArray<{ legacy: string; current: string }> = [
	{ legacy: 'copilotAlternatives.logLevel', current: 'modelMeter.logLevel' },
	{ legacy: 'copilotAlternatives.tokenUsage.backfillDays', current: 'modelMeter.tokenUsage.backfillDays' },
	{ legacy: 'copilotAlternatives.tokenUsage.watcherWindowDays', current: 'modelMeter.tokenUsage.watcherWindowDays' },
	{ legacy: 'copilotAlternatives.tokenUsage.usdToCnyRate', current: 'modelMeter.tokenUsage.usdToCnyRate' },
];

export const LEGACY_CONFIG_MIGRATION_VERSION = 1;

/** globalState keys, with their legacy names where a rename applies. */
export const STATE_KEYS = {
	/** Notification dedup set (rename: csw.seenRequestIds → modelMeter.seenRequestIds). */
	seenRequestIds: 'modelMeter.seenRequestIds',
	seenRequestIdsLegacy: 'csw.seenRequestIds',
	/** Records the executed config-migration version. */
	configMigrationVersion: 'modelMeter.migrations.legacyConfigVersion',
} as const;

export interface ConfigInspectLike {
	globalValue?: unknown;
	workspaceValue?: unknown;
	workspaceFolderValue?: unknown;
}

export type MigrateTarget = 'global' | 'workspace';

export interface MigrationPlan {
	/** Whether the legacy value should be copied to the new key. */
	migrate: boolean;
	/** Where the new value should be written (only when `migrate`). */
	target: MigrateTarget;
}

/** Pure decision function for a single key pair. */
export function planConfigMigration(newInspect: ConfigInspectLike, legacyInspect: ConfigInspectLike): MigrationPlan {
	const newExplicit =
		newInspect.globalValue !== undefined ||
		newInspect.workspaceValue !== undefined ||
		newInspect.workspaceFolderValue !== undefined;
	if (newExplicit) { return { migrate: false, target: 'global' }; }

	if (legacyInspect.globalValue !== undefined) { return { migrate: true, target: 'global' }; }
	if (legacyInspect.workspaceValue !== undefined || legacyInspect.workspaceFolderValue !== undefined) {
		return { migrate: true, target: 'workspace' };
	}
	return { migrate: false, target: 'global' };
}

/**
 * Pure decision function for the `seenRequestIds` state key: the new key wins;
 * a non-empty legacy value is used when the new key has never been written.
 */
export function planSeenRequestIdsMigration(
	newValue: string[] | undefined,
	legacyValue: string[] | undefined,
): string[] | undefined {
	if (Array.isArray(newValue)) { return newValue; }
	if (Array.isArray(legacyValue) && legacyValue.length > 0) { return [...legacyValue]; }
	return undefined;
}
