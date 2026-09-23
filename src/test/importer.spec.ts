/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * sessionStoreImporter tests — fixture-based, using the REAL VS Code chat-session
 * mutation-log structure captured from actual sessions (including a real Xiaomi
 * MiMo request shape from `globalStorage/emptyWindowChatSessions`).
 *
 * Facts these fixtures encode (verified against real data on 2026-09-23):
 *  - MiMo BYOK provider `sdmapvstool.xiaomimimo-for-copilot` registers vendor `mimo`,
 *    model ids `mimo-v2.6-flash` / `mimo-v2.6-pro` / `mimo-v2.6-pro-ultraspeed`;
 *    sessions run in folder-less windows → `emptyWindowChatSessions`.
 *  - `result.metadata.toolCallRounds[].thinking.tokens` exists for MiMo (32 in the
 *    sampled request); most other providers record only thinking text, no tokens.
 *  - Applied edits appear as `response[].kind === 'textEditGroup'` parts carrying
 *    `uri.fsPath`; `editedFileEvents[]` is sparse — both must be merged.
 *  - `result.timings` is `{ firstProgress, totalElapsed }`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSessionFile } from '../tokenUsage/sessionStoreImporter';

// ─── Fixture helpers ────────────────────────────────────────────────────────

let tmpDirs: string[] = [];
function writeSessionFile(lines: unknown[]): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-importer-spec-'));
	tmpDirs.push(dir);
	const fp = path.join(dir, 'session.jsonl');
	fs.writeFileSync(fp, lines.map((l) => JSON.stringify(l)).join('\n'), 'utf8');
	return fp;
}

/** Real MiMo request shape (subset of emptyWindowChatSessions/e3152675…). */
function mimoHeader(): unknown {
	return {
		kind: 0,
		v: {
			version: 3,
			creationDate: 1790096052877,
			initialLocation: 'panel',
			responderUsername: '',
			sessionId: 'fixture-mimo-session',
			hasPendingEdits: false,
			requests: [
				{
					requestId: 'req-mimo-1',
					timestamp: 1790123052256,
					agent: { id: 'github.copilot.editsAgent', name: 'agent' },
					modelId: 'mimo/mimo-v2.6-flash',
					responseId: 'resp-1',
					responseTimestamp: 1790123055000,
					modelState: { value: 1, completedAt: 1790123055400 },
					contentReferences: [],
					codeCitations: [],
					timeSpentWaiting: 2000,
					completionTokens: 158,
					promptTokens: 23115,
					outputBuffer: 5,
					promptTokenDetails: [
						{ category: 'System', label: 'System Instructions', percentageOfPrompt: 20 },
						{ category: 'System', label: 'Tool Definitions', percentageOfPrompt: 79 },
						{ category: 'User Context', label: 'Messages', percentageOfPrompt: 1 },
					],
					elapsedMs: 5671,
					modeInfo: { kind: 'agent' },
					response: [
						// Applied edits (real shape: uri.fsPath present, done=true)
						{ kind: 'textEditGroup', uri: { fsPath: 'C:\\demo\\src\\a.ts' }, edits: [{ text: 'x' }], done: true },
						{ kind: 'textEditGroup', uri: { fsPath: 'C:\\demo\\src\\b.ts' }, edits: [{ text: 'y' }], done: true },
						// duplicate file across groups → must dedupe
						{ kind: 'textEditGroup', uri: { fsPath: 'C:\\demo\\src\\a.ts' }, edits: [{ text: 'z' }], done: true },
						// placeholder group (not done, no edits) → must NOT count
						{ kind: 'textEditGroup', uri: { fsPath: 'C:\\demo\\src\\placeholder.ts' }, edits: [], done: false },
						{ kind: 'thinking', text: 'reasoning part (rendered)' },
					],
					// sparse working-set edit event for a third file
					editedFileEvents: [{ uri: { fsPath: 'C:\\demo\\src\\c.ts' }, eventKind: 1 }],
					message: { text: 'hi' },
					variableData: { variables: [] },
					result: {
						timings: { firstProgress: 2464, totalElapsed: 4309 },
						metadata: {
							resolvedModel: 'mimo-v2.6-flash',
							toolCallRounds: [
								{
									thinking: { id: '', text: 'reason', tokens: 32 },
									toolCalls: [{ name: 'run_in_terminal' }, { name: 'replace_string_in_file' }],
								},
							],
						},
					},
				},
			],
			inputState: {
				selectedModel: {
					identifier: 'mimo/mimo-v2.6-flash',
					metadata: {
						extension: { value: 'sdmapvstool.xiaomimimo-for-copilot', _lower: 'sdmapvstool.xiaomimimo-for-copilot' },
						id: 'mimo-v2.6-flash',
						vendor: 'mimo',
						name: 'MiMo V2.6 Flash',
						family: 'mimo',
						isBYOK: true,
					},
				},
			},
		},
	};
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('sessionStoreImporter — MiMo empty-window fixture', () => {
	it('imports a real-shaped MiMo request with vendor/extension/model metadata', () => {
		const fp = writeSessionFile([mimoHeader()]);
		const parsed = parseSessionFile(fp)!;
		expect(parsed).toBeTruthy();

		// Session level
		expect(parsed.sessionRow.session_id).toBe('fixture-mimo-session');
		expect(parsed.sessionRow.session_vendor).toBe('mimo');
		expect(parsed.sessionRow.session_model_id).toBe('mimo/mimo-v2.6-flash');
		expect(parsed.sessionRow.session_model_name).toBe('MiMo V2.6 Flash');
		expect(parsed.sessionRow.session_family).toBe('mimo');
		expect(parsed.sessionRow.session_extension).toBe('sdmapvstool.xiaomimimo-for-copilot');
		expect(parsed.sessionRow.session_is_byok).toBe(1);

		// Turn level
		expect(parsed.turnRows.length).toBe(1);
		const t = parsed.turnRows[0];
		expect(t.model_id).toBe('mimo/mimo-v2.6-flash');
		expect(t.vendor).toBe('mimo');
		expect(t.prompt_tokens).toBe(23115);
		expect(t.completion_tokens).toBe(158);
		expect(t.timestamp).toBe(1790123052256);
		expect(t.mode_kind).toBe('agent');
		expect(t.agent_name).toBe('agent');
		expect(t.resolved_model).toBe('mimo-v2.6-flash');
		// real MiMo thinking tokens
		expect(t.thinking_tokens).toBe(32);
		expect(t.tool_call_count).toBe(2);
		expect(t.tool_call_rounds).toBe(1);
		// timings
		expect(t.first_progress_ms).toBe(2464);
		expect(t.total_elapsed_ms).toBe(4309);
		expect(t.elapsed_ms).toBe(5671);
		// prompt breakdown
		expect(t.system_instructions_pct).toBe(20);
		expect(t.tool_definitions_pct).toBe(79);
		expect(t.messages_pct).toBe(1);
	});

	it('edited file count merges textEditGroup uris with editedFileEvents (dedup, no placeholders)', () => {
		const fp = writeSessionFile([mimoHeader()]);
		const parsed = parseSessionFile(fp)!;
		// a.ts (twice → once) + b.ts + c.ts(editedFileEvents) = 3; placeholder.ts excluded
		expect(parsed.turnRows[0].edited_file_count).toBe(3);
	});

	it('thinking tokens are summed only from numeric `tokens` (text-only thinking = 0)', () => {
		const header = mimoHeader() as { v: { requests: Array<Record<string, unknown>> } };
		const req = header.v.requests[0];
		(req.result as { metadata: { toolCallRounds: unknown[] } }).metadata.toolCallRounds = [
			{ thinking: { id: '', text: 'no token count here' } },
			{ thinking: { id: '', text: 'with count', tokens: 10 } },
		];
		const fp = writeSessionFile([header]);
		const parsed = parseSessionFile(fp)!;
		expect(parsed.turnRows[0].thinking_tokens).toBe(10);
	});

	it('append-only growth: kind:2 pushes additional requests (incremental sessions)', () => {
		const header = mimoHeader();
		const secondReq = {
			requestId: 'req-glm-2',
			timestamp: 1790200000000,
			agent: { id: 'github.copilot.editsAgent', name: 'agent' },
			modelId: 'glm/glm-5.3-flash',
			promptTokens: 1000,
			completionTokens: 50,
			response: [],
			message: { text: 'second' },
			result: { timings: { firstProgress: 100, totalElapsed: 200 }, metadata: { toolCallRounds: [] } },
		};
		const fp = writeSessionFile([header, { kind: 2, k: ['requests'], v: [secondReq] }]);
		const parsed = parseSessionFile(fp)!;
		expect(parsed.turnRows.length).toBe(2);
		expect(parsed.turnRows[1].model_id).toBe('glm/glm-5.3-flash');
		expect(parsed.turnRows[1].edited_file_count).toBe(0);
	});

	it('requests without token data are ignored (draft sessions import nothing)', () => {
		const header = mimoHeader() as { v: Record<string, unknown> };
		header.v.requests = [];
		const fp = writeSessionFile([header]);
		expect(parseSessionFile(fp)).toBeNull();
	});
});
