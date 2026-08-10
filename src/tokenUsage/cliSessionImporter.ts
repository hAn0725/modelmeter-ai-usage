/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionRow, TurnRow } from './metricsDatabase';
import { ParsedSession, computeFileHash } from './sessionStoreImporter';
import { isWSL, getWindowsUserDirs } from './wslUtils';

/**
 * Parses standalone GitHub Copilot CLI (`@github/copilot`) session logs.
 *
 * Session layout (per `COPILOT_HOME ?? ~/.copilot/session-state/`):
 *   • Current format (CLI ≥ v0.0.342): `<uuid>/events.jsonl`
 *   • Legacy flat format:               `<uuid>.jsonl`
 *
 * Each `events.jsonl` is a plain (non-mutation-log) chronological event
 * stream, one JSON object per line. The only event we trust for billing is
 * `session.shutdown`, whose `data.modelMetrics.{model}.totalNanoAiu` is the
 * actual API-billed AI credit ledger (1 credit = 1,000,000,000 nanoAiu).
 * Sessions that never emit `session.shutdown` (crash, Ctrl-C, still open)
 * are skipped here — matching this extension's "actual reported data only,
 * no heuristic estimation" design — and get imported on a later scan once
 * the CLI does write out a shutdown ledger.
 */

const NANO_AIU_PER_CREDIT = 1_000_000_000;

interface CliEvent {
	type: string;
	data: Record<string, unknown>;
	id: string;
	timestamp: string;
	parentId: string | null;
}

interface CliModelUsage {
	inputTokens?: number;
	outputTokens?: number;
	reasoningTokens?: number;
}

interface CliModelMetrics {
	usage?: CliModelUsage;
	totalNanoAiu?: number;
}

// ─── COPILOT_HOME resolution ────────────────────────────────────────────────

/** Root of the Copilot CLI's local state, overridable via `COPILOT_HOME` (matches the CLI's own resolution order). */
export function getCopilotHome(): string {
	return process.env.COPILOT_HOME || path.join(os.homedir(), '.copilot');
}

/**
 * Candidate `session-state` root(s) to scan, across supported environments:
 *   • Always: the current machine's root (`getCopilotHome()`, honoring `COPILOT_HOME`).
 *   • When the extension host runs inside WSL: also the Windows-side `.copilot` directory for
 *     each Windows user under `/mnt/c/Users/`, since a developer may run the Copilot CLI
 *     natively on Windows (outside the WSL remote) while VS Code itself runs in WSL.
 *
 * Native Windows (no WSL) needs no special handling: `os.homedir()` already resolves to the
 * Windows user profile, matching wherever the CLI itself writes its session-state.
 *
 * The remaining case — extension host on native Windows, CLI run inside a WSL terminal — is
 * deliberately not covered: reaching from Windows into `\\wsl$\` or `\\wsl.localhost\` can
 * mount and boot a stopped WSL distro just to check for files, which is too heavy a cost for
 * a background scan.
 */
export function getCliSessionStateRoots(): string[] {
	const roots = [path.join(getCopilotHome(), 'session-state')];

	if (isWSL()) {
		for (const user of getWindowsUserDirs()) {
			roots.push(path.join('/mnt/c/Users', user, '.copilot', 'session-state'));
		}
	}

	return roots;
}

/** True for paths under a Copilot CLI session-state root, in either the current or legacy layout. */
export function isCliSessionFilePath(filePath: string): boolean {
	return /[\\/]session-state[\\/]/.test(filePath);
}

// ─── Event log parsing ──────────────────────────────────────────────────────

function parseEventLog(content: string): CliEvent[] {
	const events: CliEvent[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) { continue; }
		try {
			events.push(JSON.parse(trimmed) as CliEvent);
		} catch {
			// skip malformed lines
		}
	}
	return events;
}

/** `<uuid>/events.jsonl` → parent dir name; legacy flat `<uuid>.jsonl` → file stem. */
function deriveSessionId(filePath: string): string {
	if (path.basename(filePath) === 'events.jsonl') {
		return path.basename(path.dirname(filePath));
	}
	return path.basename(filePath, '.jsonl');
}

function nanoAiuToCredits(raw: unknown): number | null {
	return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw / NANO_AIU_PER_CREDIT : null;
}

/**
 * CLI model IDs are bare names with no vendor prefix (e.g. "claude-sonnet-5"), and every
 * model reported in `modelMetrics` is billed through the same Copilot AI-credit ledger
 * (`totalNanoAiu`) regardless of the underlying model family — so the vendor is the billing
 * channel, 'copilot', not the underlying model provider (that would wrongly exclude these
 * rows from `getCopilotCreditsSummary()`'s `vendor = 'copilot'` filter). Only an explicit
 * `<vendor>/<model>` prefix (future BYOK/custom-endpoint usage) overrides this.
 */
function resolveCliVendor(model: string): string {
	const slashIndex = model.indexOf('/');
	return slashIndex > 0 ? model.substring(0, slashIndex) : 'copilot';
}

// ─── Main extraction ────────────────────────────────────────────────────────

/**
 * Parses a single Copilot CLI `events.jsonl` (or legacy `<uuid>.jsonl`) file.
 * Returns null if the file has no `session.shutdown` ledger yet.
 */
export function parseCliSessionFile(filePath: string): ParsedSession | null {
	const stat = fs.statSync(filePath);
	if (stat.size === 0) { return null; }

	const content = fs.readFileSync(filePath, 'utf8');
	const events = parseEventLog(content);
	if (events.length === 0) { return null; }

	const sessionId = deriveSessionId(filePath);

	let startTime: number | undefined;
	let shutdown: Record<string, unknown> | undefined;
	let shutdownTimestampMs: number | undefined;
	let turnEndCount = 0;

	for (const event of events) {
		switch (event.type) {
			case 'session.start': {
				const data = event.data ?? {};
				startTime = typeof data.startTime === 'number' ? data.startTime : (Date.parse(String(data.startTime ?? '')) || undefined);
				break;
			}
			case 'session.shutdown':
				// A session can only shut down once, but take the last just in case.
				shutdown = event.data ?? {};
				shutdownTimestampMs = Date.parse(event.timestamp) || undefined;
				break;
			case 'assistant.turn_end':
				turnEndCount++;
				break;
		}
	}

	if (!shutdown) { return null; }

	const modelMetrics = shutdown.modelMetrics as Record<string, CliModelMetrics> | undefined;
	if (!modelMetrics) { return null; }

	const models = Object.keys(modelMetrics);
	const lastModel = models.length > 0 ? models[models.length - 1] : null;

	const sessionRow: SessionRow = {
		session_id: `cli:${sessionId}`,
		file_path: filePath,
		creation_date: startTime ?? stat.birthtimeMs,
		initial_location: 'cli',
		has_pending_edits: 0,
		request_count: turnEndCount,
		session_model_id: lastModel,
		session_vendor: lastModel ? resolveCliVendor(lastModel) : 'copilot',
		session_model_name: lastModel,
		session_family: null,
		session_extension: 'GitHub.copilot-cli',
		session_is_byok: 0,
	};

	const turnRows: TurnRow[] = [];
	for (const model of models) {
		const usage = modelMetrics[model].usage ?? {};
		const promptTokens = usage.inputTokens ?? 0;
		const completionTokens = usage.outputTokens ?? 0;
		// Mirrors sessionStoreImporter's rule: skip requests with no token data.
		if (promptTokens === 0 && completionTokens === 0) { continue; }

		turnRows.push({
			request_id: `cli:${sessionId}:${model}`,
			session_id: sessionRow.session_id,
			timestamp: shutdownTimestampMs ?? startTime ?? stat.mtimeMs,
			completed_at: shutdownTimestampMs ?? null,
			elapsed_ms: null,
			first_progress_ms: null,
			total_elapsed_ms: null,
			time_spent_waiting: null,
			model_id: model,
			vendor: resolveCliVendor(model),
			model_name: null,
			resolved_model: null,
			agent_id: 'copilot-cli',
			agent_extension: 'GitHub.copilot-cli',
			agent_name: 'GitHub Copilot CLI',
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			output_buffer: null,
			copilot_credits: nanoAiuToCredits(modelMetrics[model].totalNanoAiu),
			system_instructions_pct: 0,
			tool_definitions_pct: 0,
			messages_pct: 0,
			files_pct: 0,
			tool_results_pct: 0,
			model_state: 1,
			vote: null,
			user_message_length: null,
			user_message_parts: 0,
			mode_kind: 'cli',
			is_system_initiated: 0,
			response_part_count: 0,
			content_ref_count: 0,
			code_citation_count: 0,
			edited_file_count: 0,
			followup_count: 0,
			variable_count: 0,
			tool_call_rounds: 0,
			tool_call_count: 0,
			thinking_tokens: usage.reasoningTokens ?? 0,
			estimated_cost_usd: null,
		});
	}

	if (turnRows.length === 0) { return null; }

	return {
		sessionRow,
		turnRows,
		filePath,
		fileSize: stat.size,
		fileMtime: stat.mtimeMs,
		fileHash: computeFileHash(content),
	};
}
