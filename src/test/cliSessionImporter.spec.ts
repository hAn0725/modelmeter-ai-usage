/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { parseCliSessionFile, isCliSessionFilePath } from '../tokenUsage/cliSessionImporter';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'sample-cli-events.jsonl');

describe('isCliSessionFilePath', () => {
	it('matches paths under a session-state directory', () => {
		expect(isCliSessionFilePath('/home/user/.copilot/session-state/abc/events.jsonl')).toBe(true);
		expect(isCliSessionFilePath('/home/user/.copilot/session-state/abc.jsonl')).toBe(true);
	});

	it('does not match unrelated chat session paths', () => {
		expect(isCliSessionFilePath('/home/user/.config/Code/User/workspaceStorage/x/chatSessions/y.jsonl')).toBe(false);
	});
});

describe('parseCliSessionFile', () => {
	it('parses a session with a shutdown ledger into one turn row per model', () => {
		const parsed = parseCliSessionFile(FIXTURE_PATH);
		expect(parsed).not.toBeNull();
		expect(parsed!.sessionRow.session_vendor).toBe('copilot'); // billing channel, not the underlying model provider
		expect(parsed!.sessionRow.initial_location).toBe('cli');
		expect(parsed!.sessionRow.session_extension).toBe('GitHub.copilot-cli');
		expect(parsed!.sessionRow.request_count).toBe(2); // two assistant.turn_end events in the fixture
		expect(parsed!.turnRows).toHaveLength(2);

		const turn = parsed!.turnRows.find(t => t.model_id === 'claude-sonnet-5')!;
		expect(turn.vendor).toBe('copilot'); // billed through Copilot AI credits regardless of underlying model
		expect(turn.prompt_tokens).toBe(2815529);
		expect(turn.completion_tokens).toBe(27611);
		expect(turn.thinking_tokens).toBe(1852);
		expect(turn.copilot_credits).toBeCloseTo(98.11453, 5); // 98114530000 nanoAiu / 1e9
		expect(turn.model_state).toBe(1);
		expect(turn.agent_id).toBe('copilot-cli');
	});

	it('uses the "copilot" vendor for any bare (unprefixed) model name', () => {
		const parsed = parseCliSessionFile(FIXTURE_PATH);
		const unrecognized = parsed!.turnRows.find(t => t.model_id === 'some-unrecognized-model')!;
		expect(unrecognized.vendor).toBe('copilot');
	});
});
