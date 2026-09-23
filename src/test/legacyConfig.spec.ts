/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Legacy namespace migration planner tests: new config wins, migration only
 * when the new key is not explicitly set, and the seenRequestIds key rename.
 */

import { describe, it, expect } from 'vitest';
import {
	LEGACY_CONFIG_MAP,
	LEGACY_CONFIG_MIGRATION_VERSION,
	STATE_KEYS,
	planConfigMigration,
	planSeenRequestIdsMigration,
} from '../tokenUsage/legacyConfig';

describe('legacyConfig.planConfigMigration', () => {
	it('新 key 已显式设置 → 永不覆盖', () => {
		expect(planConfigMigration({ globalValue: 5 }, { globalValue: 3 })).toEqual({ migrate: false, target: 'global' });
		expect(planConfigMigration({ workspaceValue: 5 }, { globalValue: 3 })).toEqual({ migrate: false, target: 'global' });
		expect(planConfigMigration({ workspaceFolderValue: 5 }, { globalValue: 3 })).toEqual({ migrate: false, target: 'global' });
	});

	it('旧 key 有显式用户值 且 新 key 未设置 → 迁移，并保留来源层级', () => {
		expect(planConfigMigration({}, { globalValue: 90 })).toEqual({ migrate: true, target: 'global' });
		expect(planConfigMigration({}, { workspaceValue: 90 })).toEqual({ migrate: true, target: 'workspace' });
		expect(planConfigMigration({}, { workspaceFolderValue: 90 })).toEqual({ migrate: true, target: 'workspace' });
	});

	it('两边都没有显式值 → 不迁移（使用默认值）', () => {
		expect(planConfigMigration({}, {})).toEqual({ migrate: false, target: 'global' });
	});
});

describe('legacyConfig.planSeenRequestIdsMigration', () => {
	it('新 key 存在（即使为空数组）→ 新 key 优先', () => {
		expect(planSeenRequestIdsMigration([], ['legacy-1'])).toEqual([]);
		expect(planSeenRequestIdsMigration(['new-1'], ['legacy-1'])).toEqual(['new-1']);
	});

	it('新 key 未写入 且 旧 key 非空 → 使用旧值副本', () => {
		expect(planSeenRequestIdsMigration(undefined, ['a', 'b'])).toEqual(['a', 'b']);
	});

	it('都不存在或旧值为空 → undefined', () => {
		expect(planSeenRequestIdsMigration(undefined, undefined)).toBeUndefined();
		expect(planSeenRequestIdsMigration(undefined, [])).toBeUndefined();
	});
});

describe('legacyConfig 映射表', () => {
	it('4 个键全部从 copilotAlternatives.* 指向 modelMeter.*，且迁移版本可记录', () => {
		expect(LEGACY_CONFIG_MAP).toHaveLength(4);
		for (const { legacy, current } of LEGACY_CONFIG_MAP) {
			expect(legacy.startsWith('copilotAlternatives.')).toBe(true);
			expect(current.startsWith('modelMeter.')).toBe(true);
			expect(legacy.replace('copilotAlternatives.', '')).toBe(current.replace('modelMeter.', ''));
		}
		expect(LEGACY_CONFIG_MIGRATION_VERSION).toBeGreaterThanOrEqual(1);
		expect(STATE_KEYS.seenRequestIds).toBe('modelMeter.seenRequestIds');
		expect(STATE_KEYS.seenRequestIdsLegacy).toBe('csw.seenRequestIds');
	});
});
