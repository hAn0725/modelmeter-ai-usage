/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ILogService } from '../platform/log/common/logService';
import { getCliSessionStateRoots } from './cliSessionImporter';
import type { MetricsService } from './metricsService';

// ─── Settings ────────────────────────────────────────────────────────────────

const SETTING_WATCHER_WINDOW_DAYS = 'copilotAlternatives.tokenUsage.watcherWindowDays';
const DEFAULT_WATCHER_WINDOW_DAYS = 1;

/** Debounce window for events.jsonl changes — a session receives many rapid appends per turn. */
const DEBOUNCE_MS = 2000;

/**
 * Watches `${COPILOT_HOME ?? ~/.copilot}/session-state/**` for standalone
 * GitHub Copilot CLI (`@github/copilot`) session logs. Each session writes
 * an append-only `events.jsonl` (or, in legacy CLI versions, a flat
 * `<uuid>.jsonl`) — see cliSessionImporter.ts for the ledger format.
 *
 * Watches every root returned by `getCliSessionStateRoots()`: the current
 * machine's root, plus — when the extension host runs inside WSL — each
 * Windows user's `.copilot` directory reachable via `/mnt/c/`, since the CLI
 * may be run natively on Windows while VS Code runs in a WSL remote window.
 */
export class CliSessionWatcher implements vscode.Disposable {
	private readonly _log: ILogService;
	private readonly _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private _metricsService: MetricsService | undefined;

	constructor(logService: ILogService) {
		this._log = logService;
	}

	/** Wire to MetricsService so file changes trigger DB imports. */
	setMetricsService(ms: MetricsService): void {
		this._metricsService = ms;
	}

	activate(context: vscode.ExtensionContext): void {
		const roots = getCliSessionStateRoots().filter(root => fs.existsSync(root));
		if (roots.length === 0) {
			this._log.debug('CliSessionWatcher: no session-state directory found — Copilot CLI not detected');
			return;
		}

		for (const root of roots) {
			setImmediate(() => this._initialScan(root));
			this._registerWatchers(context, root);
		}
		context.subscriptions.push(this);

		this._log.info(`CliSessionWatcher: active for ${roots.join(', ')}`);
	}

	reloadAll(): void {
		for (const root of getCliSessionStateRoots()) {
			if (fs.existsSync(root)) { this._initialScan(root); }
		}
	}

	dispose(): void {
		for (const timer of this._debounceTimers.values()) { clearTimeout(timer); }
		this._debounceTimers.clear();
	}

	// ── Initial scan ─────────────────────────────────────────────────────

	private _initialScan(root: string): void {
		const days = vscode.workspace.getConfiguration()
			.get<number>(SETTING_WATCHER_WINDOW_DAYS, DEFAULT_WATCHER_WINDOW_DAYS);
		const cutoffMs = Date.now() - days * 86400000;

		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(root, { withFileTypes: true });
		} catch (err) {
			this._log.warn(`CliSessionWatcher: initial scan failed: ${err instanceof Error ? err.message : String(err)}`);
			return;
		}

		for (const entry of entries) {
			const fp = entry.isDirectory()
				? path.join(root, entry.name, 'events.jsonl')
				: (entry.name.endsWith('.jsonl') ? path.join(root, entry.name) : undefined);
			if (!fp) { continue; }
			try {
				if (!fs.existsSync(fp)) { continue; }
				const stat = fs.statSync(fp);
				if (stat.size === 0 || stat.mtimeMs < cutoffMs) { continue; }
				this._processFile(fp);
			} catch {
				// skip inaccessible entries
			}
		}
	}

	// ── VS Code FSWatcher registration ───────────────────────────────────

	private _registerWatchers(context: vscode.ExtensionContext, root: string): void {
		const rootUri = vscode.Uri.file(root);

		// Current format: <uuid>/events.jsonl
		const watcherA = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(rootUri, '*/events.jsonl')
		);
		watcherA.onDidCreate(uri => this._processFile(uri.fsPath));
		watcherA.onDidChange(uri => this._processFile(uri.fsPath));
		context.subscriptions.push(watcherA);

		// Legacy flat format: <uuid>.jsonl
		const watcherB = vscode.workspace.createFileSystemWatcher(
			new vscode.RelativePattern(rootUri, '*.jsonl')
		);
		watcherB.onDidCreate(uri => this._processFile(uri.fsPath));
		watcherB.onDidChange(uri => this._processFile(uri.fsPath));
		context.subscriptions.push(watcherB);
	}

	private _processFile(filePath: string): void {
		const existingTimer = this._debounceTimers.get(filePath);
		if (existingTimer) { clearTimeout(existingTimer); }
		this._debounceTimers.set(filePath, setTimeout(() => {
			this._debounceTimers.delete(filePath);
			void this._metricsService?.importSingleFile(filePath).catch(err =>
				this._log.warn(`CliSessionWatcher: import failed for ${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`)
			);
		}, DEBOUNCE_MS));
	}
}
