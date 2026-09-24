/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { MetricsDatabase, ActiveSessionMetrics, DashboardSummary, VendorAgg, ModelAgg, ModelDayTotal, ModelPromptBreakdown, SessionSummary, SessionDetail, SessionFilterOptions } from './metricsDatabase';
import { parseSessionFile, computeFileHash, ParsedSession } from './sessionStoreImporter';
import { estimateTurnCost } from './tokenCostEstimator';
import { IMPORTER_VERSION } from './importerVersion';
import { ILogService } from '../platform/log/common/logService';
import { isWSL, getWindowsUserDirs } from './wslUtils';

function getWorkspaceStorageRoots(home: string): string[] {
	const roots: string[] = [];

	if (process.platform === 'win32') {
		roots.push(
			path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage'),
			path.join(home, 'AppData', 'Roaming', 'Code - Insiders', 'User', 'workspaceStorage'),
		);
	} else if (process.platform === 'darwin') {
		roots.push(
			path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
			path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'),
		);
	} else {
		roots.push(
			path.join(home, '.config', 'Code', 'User', 'workspaceStorage'),
			path.join(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'),
			path.join(home, '.config', 'code-oss-dev', 'User', 'workspaceStorage'),
		);

		if (isWSL()) {
			const winUsers = getWindowsUserDirs();
			for (const user of winUsers) {
				const base = path.join('/mnt/c/Users', user, 'AppData', 'Roaming');
				roots.push(
					path.join(base, 'Code', 'User', 'workspaceStorage'),
					path.join(base, 'Code - Insiders', 'User', 'workspaceStorage'),
				);
			}
		}
	}

	roots.push(
		path.join(home, '.vscode-server', 'data', 'User', 'workspaceStorage'),
		path.join(home, '.vscode-server-insiders', 'data', 'User', 'workspaceStorage'),
	);

	roots.push(
		path.join(home, '.vscode-oss-dev', 'User', 'workspaceStorage'),
	);

	return roots;
}

/**
 * Returns candidate `globalStorage/emptyWindowChatSessions` directories.
 *
 * VS Code stores chat sessions from windows WITHOUT an open folder here as flat
 * `*.jsonl` files. They are not under workspaceStorage, so they were previously
 * missed entirely (e.g. Xiaomi MiMo BYOK sessions in a no-folder window).
 */
function getEmptyWindowSessionRoots(home: string): string[] {
	const roots: string[] = [];
	const userDirs: string[] = [];

	if (process.platform === 'win32') {
		userDirs.push(
			path.join(home, 'AppData', 'Roaming', 'Code', 'User'),
			path.join(home, 'AppData', 'Roaming', 'Code - Insiders', 'User'),
		);
	} else if (process.platform === 'darwin') {
		userDirs.push(
			path.join(home, 'Library', 'Application Support', 'Code', 'User'),
			path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User'),
		);
	} else {
		userDirs.push(
			path.join(home, '.config', 'Code', 'User'),
			path.join(home, '.config', 'Code - Insiders', 'User'),
			path.join(home, '.config', 'code-oss-dev', 'User'),
		);

		if (isWSL()) {
			for (const user of getWindowsUserDirs()) {
				userDirs.push(
					path.join('/mnt/c/Users', user, 'AppData', 'Roaming', 'Code', 'User'),
					path.join('/mnt/c/Users', user, 'AppData', 'Roaming', 'Code - Insiders', 'User'),
				);
			}
		}
	}

	userDirs.push(
		path.join(home, '.vscode-server', 'data', 'User'),
		path.join(home, '.vscode-server-insiders', 'data', 'User'),
		path.join(home, '.vscode-oss-dev', 'User'),
	);

	for (const userDir of userDirs) {
		roots.push(path.join(userDir, 'globalStorage', 'emptyWindowChatSessions'));
	}
	return roots;
}

// ─── Backfill window ───────────────────────────────────────────────────────

const SETTING_BACKFILL_DAYS = 'modelMeter.tokenUsage.backfillDays';
const DEFAULT_BACKFILL_DAYS = 60;

/**
 * Returns the epoch-ms cutoff for files to import. Files with mtime older
 * than this are skipped during enumeration. Controlled by the
 * `modelMeter.tokenUsage.backfillDays` setting (default 60).
 */
function getBackfillCutoffMs(): number {
	const days = vscode.workspace.getConfiguration()
		.get<number>(SETTING_BACKFILL_DAYS, DEFAULT_BACKFILL_DAYS);
	return Date.now() - (days * 86400000);
}

// ─── File candidate enumeration ─────────────────────────────────────────────

interface FileCandidate {
	path: string;
	size: number;
	mtime: number;
}

/** Parses a VS Code chat-session (.jsonl mutation log) file. */
function parseAnySessionFile(filePath: string): ParsedSession | null {
	return parseSessionFile(filePath);
}

function enumerateAllJsonlFiles(log: ILogService): FileCandidate[] {
	const candidates: FileCandidate[] = [];
	const roots = getWorkspaceStorageRoots(os.homedir());
	const seen = new Set<string>();
	const cutoffMs = getBackfillCutoffMs();

	for (const root of roots) {
		try {
			if (!fs.existsSync(root)) { continue; }
			const wsEntries = fs.readdirSync(root, { withFileTypes: true });
			for (const wsEntry of wsEntries) {
				if (!wsEntry.isDirectory()) { continue; }
				const chatDir = path.join(root, wsEntry.name, 'chatSessions');
				if (!fs.existsSync(chatDir)) { continue; }

				try {
					const files = fs.readdirSync(chatDir).filter(f => f.endsWith('.jsonl'));
					for (const file of files) {
						const fp = path.join(chatDir, file);
						if (seen.has(fp)) { continue; }
						seen.add(fp);
						try {
							const stat = fs.statSync(fp);
							if (stat.size === 0) { continue; }
							// Skip files older than the backfill window
							if (stat.mtimeMs < cutoffMs) { continue; }
							// Do NOT read content or compute hash here.
							// JSONL is append-only — file size is a sufficient
							// change detector for knowing whether something changed.
							candidates.push({
								path: fp,
								size: stat.size,
								mtime: stat.mtimeMs,
							});
						} catch {
							// skip inaccessible files
						}
					}
				} catch {
					// skip inaccessible chatSessions dirs
				}
			}
		} catch {
			// skip inaccessible roots
		}
	}

	// Empty-window chat sessions: flat `*.jsonl` files directly inside the root
	// (windows without an open folder) — not under workspaceStorage.
	for (const root of getEmptyWindowSessionRoots(os.homedir())) {
		try {
			if (!fs.existsSync(root)) { continue; }
			const files = fs.readdirSync(root).filter(f => f.endsWith('.jsonl'));
			for (const file of files) {
				const fp = path.join(root, file);
				if (seen.has(fp)) { continue; }
				seen.add(fp);
				try {
					const stat = fs.statSync(fp);
					if (stat.size === 0) { continue; }
					if (stat.mtimeMs < cutoffMs) { continue; }
					candidates.push({ path: fp, size: stat.size, mtime: stat.mtimeMs });
				} catch {
					// skip inaccessible files
				}
			}
		} catch {
			// skip inaccessible roots
		}
	}

	return candidates;
}

function findMostRecentWorkspaceDir(log: ILogService): FileCandidate[] {
	const candidates: FileCandidate[] = [];
	const roots = getWorkspaceStorageRoots(os.homedir());
	let newestDir = '';
	let newestMtime = 0;

	for (const root of roots) {
		try {
			if (!fs.existsSync(root)) { continue; }
			const wsEntries = fs.readdirSync(root, { withFileTypes: true });
			for (const wsEntry of wsEntries) {
				if (!wsEntry.isDirectory()) { continue; }
				const chatDir = path.join(root, wsEntry.name, 'chatSessions');
				if (!fs.existsSync(chatDir)) { continue; }
				try {
					const stat = fs.statSync(chatDir);
					if (stat.mtimeMs > newestMtime) {
						newestMtime = stat.mtimeMs;
						newestDir = chatDir;
					}
				} catch { /* skip */ }
			}
		} catch { /* skip */ }
	}

	if (!newestDir) { return candidates; }

	// Return up to 5 most recent files from the newest directory
	try {
		const files = fs.readdirSync(newestDir)
			.filter(f => f.endsWith('.jsonl'))
			.map(f => {
				const fp = path.join(newestDir, f);
				const st = fs.statSync(fp);
				return { path: fp, size: st.size, mtime: st.mtimeMs };
			})
			.sort((a, b) => b.mtime - a.mtime)
			.slice(0, 5);

		candidates.push(...files);
	} catch { /* skip */ }

	return candidates;
}

// ─── MetricsService ─────────────────────────────────────────────────────────

/** Result summary of one import pass (quick / background / rebuild). */
export interface ImportPassStats {
	/** Files discovered within the backfill window. */
	discovered: number;
	/** Files that were new or changed (parsed). */
	changed: number;
	/** Files successfully imported (with >=1 turn). */
	imported: number;
	/** Files skipped because unchanged (same size and current importer version). */
	skipped: number;
	/** Turns written in this pass. */
	turns: number;
	/** Wall-clock duration in ms. */
	ms: number;
}

export class MetricsService implements vscode.Disposable {
	private _db: MetricsDatabase;
	private _log: ILogService;

	constructor(dbPath: string, log: ILogService) {
		this._log = log;
		this._db = new MetricsDatabase(dbPath);
	}

	/**
	 * Returns the configured backfill window in days from settings,
	 * or the default (60 days).
	 */
	protected _backfillDays(): number {
		return vscode.workspace.getConfiguration()
			.get<number>(SETTING_BACKFILL_DAYS, DEFAULT_BACKFILL_DAYS);
	}

	// ── Layer 1: Quick batch (async, <500ms) ──────────────────────────

	async quickImport(): Promise<ImportPassStats> {
		const enumStart = Date.now();
		const candidates = findMostRecentWorkspaceDir(this._log);
		const enumMs = Date.now() - enumStart;
		const stats: ImportPassStats = { discovered: candidates.length, changed: 0, imported: 0, skipped: 0, turns: 0, ms: 0 };
		if (candidates.length === 0) {
			this._log.debug('Quick import: no recent session files found');
			return stats;
		}

		const startTime = Date.now();
		try {
			for (const c of candidates) {
				// changed-only: skip files already imported with the current importer version
				const existing = await this._db.getProcessedFile(c.path);
				if (existing && existing.file_size === c.size && (existing.importer_version ?? 0) >= IMPORTER_VERSION) {
					stats.skipped++;
					continue;
				}
				stats.changed++;

				const parsed = parseAnySessionFile(c.path);
				if (!parsed) {
					// Draft/empty session file — remember it as processed so it is not
					// re-parsed every pass; any future append changes the size and the
					// normal change detection picks it up again.
					await this._db.markFileProcessed(c.path, c.size, c.mtime, '');
					continue;
				}

				// Estimate per-turn costs at official API list prices. Requests whose
				// model has no confirmable official price keep both cost columns null
				// (shown as N/A in UI). DeepSeek applies timestamp-based peak/off-peak rules.
				for (const req of parsed.turnRows) {
					const costEstimate = estimateTurnCost(
						req.prompt_tokens,
						req.completion_tokens,
						0,
						req.model_id,
						req.timestamp
					);
					req.estimated_cost_usd = costEstimate && costEstimate.currency === 'USD' ? costEstimate.total : null;
					req.estimated_cost_cny = costEstimate && costEstimate.currency === 'CNY' ? costEstimate.total : null;
				}

				await this._db.runInTransaction(async () => {
					await this._db.upsertSession(parsed.sessionRow);
					for (const req of parsed.turnRows) {
						await this._db.upsertTurn(req);
					}
					await this._db.markFileProcessed(parsed.filePath, parsed.fileSize, parsed.fileMtime, parsed.fileHash);
				});
				stats.imported++;
				stats.turns += parsed.turnRows.length;

				// Yield to the event loop between files so the UI stays responsive.
				await new Promise<void>(r => setImmediate(r));
			}
		} catch (err) {
			this._log.warn(`Quick import failed: ${err instanceof Error ? err.message : String(err)}`);
		}

		stats.ms = Date.now() - startTime;
		if (stats.imported > 0) {
			this._log.info(`Quick import: ${stats.imported} file(s), ${stats.turns} turn(s) in ${stats.ms}ms (${stats.discovered} recent discovered in ${enumMs}ms, ${stats.skipped} unchanged)`);
		} else {
			this._log.debug(`Quick import: nothing changed (${stats.discovered} recent files, all unchanged)`);
		}
		return stats;
	}

	// ── Layer 2: Background catch-up (async, ~2-5s) ─────────────────────

	async backgroundImport(): Promise<ImportPassStats> {
		const startTime = Date.now();
		const stats: ImportPassStats = { discovered: 0, changed: 0, imported: 0, skipped: 0, turns: 0, ms: 0 };

		// Synchronous fs.readdirSync/statSync walk — keep it brief; files are
		// filtered by mtime/size before any parsing happens.
		const enumStart = Date.now();
		const allFiles = enumerateAllJsonlFiles(this._log);
		const enumMs = Date.now() - enumStart;
		stats.discovered = allFiles.length;
		if (allFiles.length === 0) {
			this._log.debug('Background sync: no session files discovered');
			return stats;
		}

		const changedFiles = await this._db.findChangedFiles(allFiles);
		stats.changed = changedFiles.length;
		stats.skipped = allFiles.length - changedFiles.length;
		this._log.debug(`Background sync: ${allFiles.length} file(s) discovered (${enumMs}ms), ${changedFiles.length} changed, ${stats.skipped} unchanged`);

		const BATCH_SIZE = 10;
		for (let i = 0; i < changedFiles.length; i += BATCH_SIZE) {
			const batch = changedFiles.slice(i, i + BATCH_SIZE);

			try {
				await this._db.runInTransaction(async () => {
					for (const fp of batch) {
						const parsed = parseAnySessionFile(fp);
						if (!parsed) {
							// Draft/empty file — mark as processed (see quickImport) so it is
							// skipped until it actually grows.
							try {
								const st = fs.statSync(fp);
								await this._db.markFileProcessed(fp, st.size, st.mtimeMs, '');
							} catch { /* file vanished */ }
							continue;
						}

						for (const req of parsed.turnRows) {
							const costEstimate = estimateTurnCost(
								req.prompt_tokens,
								req.completion_tokens,
								0,
								req.model_id,
								req.timestamp
							);
							req.estimated_cost_usd = costEstimate && costEstimate.currency === 'USD' ? costEstimate.total : null;
							req.estimated_cost_cny = costEstimate && costEstimate.currency === 'CNY' ? costEstimate.total : null;
						}

						await this._db.upsertSession(parsed.sessionRow);
						for (const req of parsed.turnRows) {
							await this._db.upsertTurn(req);
						}
						await this._db.markFileProcessed(parsed.filePath, parsed.fileSize, parsed.fileMtime, parsed.fileHash);
						stats.imported++;
						stats.turns += parsed.turnRows.length;
					}
				});
			} catch (err) {
				this._log.warn(`Background sync: batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err instanceof Error ? err.message : String(err)}`);
			}

			// Yield between batches to keep the extension host responsive.
			await new Promise<void>(r => setImmediate(r));
		}

		stats.ms = Date.now() - startTime;
		this._log.info(`Background sync: ${stats.changed} changed session(s), ${stats.turns} turn(s), ${stats.ms}ms (${stats.discovered} discovered, ${stats.skipped} unchanged, enum ${enumMs}ms)`);
		return stats;
	}

	// ── Layer 3: Incremental file import (for fs.watch) ──────────────────

	/**
	 * Imports a single .jsonl file if it's new or changed since the last import.
	 * JSONL is append-only, so file size comparison is a sufficient change detector.
	 * Returns true if the file was actually imported, false if it was skipped
	 * (unchanged, empty, or unparseable).
	 */
	async importSingleFile(filePath: string): Promise<boolean> {
		const startTime = Date.now();
		try {
			// Quick skip: check if file is already tracked and unchanged
			// (fs.statSync is synchronous/blocking, but this is a single stat call)
			const stat = fs.statSync(filePath);
			if (stat.size === 0) { return false; }

			const existing = await this._db.getProcessedFile(filePath);
			if (existing && existing.file_size === stat.size && (existing.importer_version ?? 0) >= IMPORTER_VERSION) {
				this._log.debug(`MetricsService: skipped ${path.basename(filePath)} (already processed, size=${stat.size})`);
				return false;
			}

			// parseAnySessionFile is fully synchronous (fs.readFileSync + JSON parsing) —
			// blocks the extension host thread for the duration of the parse.
			const parseStart = Date.now();
			const parsed = parseAnySessionFile(filePath);
			const parseMs = Date.now() - parseStart;
			if (!parsed) {
				// Draft/empty file — mark processed (see quickImport) and report
				// "not imported" so no live event is emitted.
				await this._db.markFileProcessed(filePath, stat.size, stat.mtimeMs, '');
				return false;
			}

			for (const req of parsed.turnRows) {
				const costEstimate = estimateTurnCost(
					req.prompt_tokens,
					req.completion_tokens,
					0,
					req.model_id,
					req.timestamp
				);
				req.estimated_cost_usd = costEstimate && costEstimate.currency === 'USD' ? costEstimate.total : null;
				req.estimated_cost_cny = costEstimate && costEstimate.currency === 'CNY' ? costEstimate.total : null;
			}

			await this._db.runInTransaction(async () => {
				await this._db.upsertSession(parsed.sessionRow);
				for (const req of parsed.turnRows) {
					await this._db.upsertTurn(req);
				}
				await this._db.markFileProcessed(parsed.filePath, parsed.fileSize, parsed.fileMtime, parsed.fileHash);
			});

			const elapsed = Date.now() - startTime;
			this._log.debug(`Imported ${path.basename(filePath)} (${parsed.turnRows.length} requests) in ${elapsed}ms (parsing: ${parseMs}ms)`);
			return true;
		} catch (err) {
			this._log.warn(`MetricsService: import failed for ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	}

	// ── Rebuild ──────────────────────────────────────────────────────────

	// Rebuild all data from disk within the configured backfill window.
	// Uses the modelMeter.tokenUsage.backfillDays setting.
	async rebuildAll(): Promise<void> {
		const days = this._backfillDays();
		const startTime = Date.now();
		this._log.info(`Rebuilding all data (backfill: ${days} days)...`);
		await this._db.clearAllData();

		// Synchronous fs.readdirSync/statSync walk.
		const enumStart = Date.now();
		const allFiles = enumerateAllJsonlFiles(this._log);
		const enumMs = Date.now() - enumStart;
		this._log.debug(`Rebuilding from ${allFiles.length} files (enumeration: ${enumMs}ms)`);

		const BATCH_SIZE = 10;
		let imported = 0;
		let parseMs = 0;

		for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
			const batch = allFiles.slice(i, i + BATCH_SIZE);

			try {
				await this._db.runInTransaction(async () => {
						for (const c of batch) {
							const parseStart = Date.now();
							const parsed = parseAnySessionFile(c.path);
							parseMs += Date.now() - parseStart;
							if (!parsed) {
								// Draft/empty file — record it so the next rebuild diff is clean.
								await this._db.markFileProcessed(c.path, c.size, c.mtime, '');
								continue;
							}

							for (const req of parsed.turnRows) {
								const costEstimate = estimateTurnCost(
									req.prompt_tokens,
									req.completion_tokens,
									0,
									req.model_id,
									req.timestamp
								);
								req.estimated_cost_usd = costEstimate && costEstimate.currency === 'USD' ? costEstimate.total : null;
								req.estimated_cost_cny = costEstimate && costEstimate.currency === 'CNY' ? costEstimate.total : null;
							}

							await this._db.upsertSession(parsed.sessionRow);
							for (const req of parsed.turnRows) {
								await this._db.upsertTurn(req);
							}
							await this._db.markFileProcessed(c.path, c.size, c.mtime, parsed.fileHash);
							imported++;
						}
				});
			} catch (err) {
				this._log.warn(`MetricsService: rebuild batch failed: ${err instanceof Error ? err.message : String(err)}`);
			}

			await new Promise<void>(r => setImmediate(r));
		}

		const elapsed = Date.now() - startTime;
		this._log.info(`Rebuild complete: ${imported} file(s) imported in ${elapsed}ms (enumeration: ${enumMs}ms)`);
	}

	// ── Diagnostics (used by the “Token 用量诊断” command) ────────────

	/**
	 * Full diagnostic dump: storage roots, file discovery, changed-file diff,
	 * processed_files importer versions and unpriced (N/A) models.
	 * Returned as plain lines so the caller decides where to print them.
	 */
	async getDiagnostics(): Promise<string[]> {
		const lines: string[] = [];
		const home = os.homedir();

		const wsRoots = getWorkspaceStorageRoots(home);
		const wsExisting = wsRoots.filter(r => fs.existsSync(r));
		const ewRoots = getEmptyWindowSessionRoots(home);
		const ewExisting = ewRoots.filter(r => fs.existsSync(r));
		lines.push(`Roots: workspaceStorage ${wsExisting.length}/${wsRoots.length} exist; emptyWindow ${ewExisting.length}/${ewRoots.length} exist`);
		for (const r of wsExisting) { lines.push(`  [workspace] ${r}`); }
		for (const r of ewExisting) { lines.push(`  [emptyWindow] ${r}`); }

		const files = enumerateAllJsonlFiles(this._log);
		lines.push(`Discovered (backfill window): ${files.length} jsonl file(s)`);
		const changed = await this._db.findChangedFiles(files);
		lines.push(`Changed vs processed_files: ${changed.length} (importer version ${IMPORTER_VERSION})`);
		for (const fp of changed.slice(0, 12)) { lines.push(`  ~ ${fp}`); }
		if (changed.length > 12) { lines.push(`  … and ${changed.length - 12} more`); }

		const pf = await this._db.getProcessedFileStats();
		lines.push(`processed_files: total=${pf.total}, current=${pf.current}, stale=${pf.stale} (stale will be re-parsed once by the background sync)`);

		const unpriced = await this._db.getUnpricedModels();
		lines.push(`Unpriced (N/A) turns by model: ${unpriced.reduce((s, u) => s + u.n, 0)}`);
		for (const u of unpriced.slice(0, 15)) { lines.push(`  ${u.model_id} (vendor=${u.vendor}) ×${u.n}`); }
		return lines;
	}

	// ── Dashboard queries ────────────────────────────────────────────────

	async getDashboardSummary(days = 30): Promise<DashboardSummary> {
		return this._db.getDashboardSummary(days);
	}

	/** Vendor breakdown for the last 7 days, ordered by total tokens descending. */
	async getVendorBreakdown7d(): Promise<VendorAgg[]> {
		return this._db.getVendorBreakdown(7);
	}

	/** Model breakdown for the last 7 days, optionally filtered by vendor. */
	async getModelBreakdown7d(vendor?: string): Promise<ModelAgg[]> {
		return this._db.getModelBreakdown(7, vendor);
	}

	async getSessionCount(): Promise<number> {
		return this._db.getSessionCount();
	}

	async getRequestCount(): Promise<number> {
		return this._db.getRequestCount();
	}

	// ── Vendor & Model View summaries ───────────────────────────────────

	/** Vendor view summary scoped to a single vendor. */
	async getVendorViewSummary(vendor: string, days = 30): Promise<{ models: ModelAgg[]; dailyByModel: ModelDayTotal[]; allTimeTokens: number; allTimeRequests: number; firstTrackedDate: string | null }> {
		const [models, dailyByModel, allVendors, firstDateRow] = await Promise.all([
			this._db.getModelBreakdown(days, vendor),
			this._db.getDayTotalsByModel(days, vendor),
			this._db.getDayTotalsByVendor(days, vendor),
			this._db.getFirstTrackedDate(),
		]);
		const allTimeTokens = allVendors.reduce((s, d) => s + d.totalTokens, 0);
		const allTimeRequests = allVendors.reduce((s, d) => s + d.requestCount, 0);
		return { models, dailyByModel, allTimeTokens, allTimeRequests, firstTrackedDate: firstDateRow?.firstTrackedDate ?? null };
	}

	/** Model view summary. Optionally filtered by vendor/model and time range. */
	async getModelViewSummary(vendor?: string, modelId?: string, days = 30): Promise<{ models: ModelAgg[]; dailyByModel: ModelDayTotal[]; promptBreakdowns: ModelPromptBreakdown[]; firstTrackedDate: string | null }> {
		const [models, dailyByModel, promptBreakdowns, firstDateRow] = await Promise.all([
			this._db.getModelBreakdown(days, vendor),
			this._db.getDayTotalsByModel(days, vendor, modelId),
			this._db.getModelPromptBreakdown(days, vendor, modelId),
			this._db.getFirstTrackedDate(),
		]);
		return { models, dailyByModel, promptBreakdowns, firstTrackedDate: firstDateRow?.firstTrackedDate ?? null };
	}

	/** List of all distinct vendors with usage in last 30 days. */
	async getAllVendors(): Promise<string[]> {
		const vendors = await this._db.getVendorBreakdown(30);
		return vendors.map(v => v.vendor).sort();
	}

	/** Daily totals grouped by vendor, optionally filtered to a single vendor. */
	async getDayTotalsByVendor(days: number, vendor?: string) {
		return this._db.getDayTotalsByVendor(days, vendor);
	}

	/** Model breakdown for an arbitrary window, optionally filtered by vendor. */
	async getModelBreakdown(days: number, vendor?: string): Promise<ModelAgg[]> {
		return this._db.getModelBreakdown(days, vendor);
	}

	// ── Session list / detail queries ───────────────────────────────────

	async listSessions(
		days: number,
		filters?: { modelName?: string },
	): Promise<SessionSummary[]> {
		return this._db.listSessions(days, filters);
	}

	async getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
		return this._db.getSessionDetail(sessionId);
	}

	/** Recent model-ids (newest first, one row per model) for account-provider resolution. */
	async getRecentModelIds(limit = 30): Promise<string[]> {
		return this._db.getRecentModelIds(limit);
	}

	/** Aggregated metrics of the active (latest) conversation — status bar “本轮”. */
	async getActiveSessionMetrics(): Promise<ActiveSessionMetrics | null> {
		return this._db.getActiveSessionMetrics();
	}

	async getSessionFilterOptions(): Promise<SessionFilterOptions> {
		return this._db.getSessionFilterOptions();
	}

	// ── Dispose ──────────────────────────────────────────────────────────

	dispose(): void {
		this._db.close();
	}
}
