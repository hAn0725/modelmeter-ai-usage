/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';

let _isWsl: boolean | undefined;

/**
 * Detects whether the current process is running inside WSL (Windows Subsystem for Linux).
 * Cached after first call.
 */
export function isWSL(): boolean {
	if (_isWsl !== undefined) { return _isWsl; }
	try {
		const version = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
		_isWsl = version.includes('microsoft') || version.includes('wsl');
	} catch {
		_isWsl = false;
	}
	return _isWsl;
}

/**
 * When running in WSL, VS Code (or a standalone CLI) may instead be running natively on
 * Windows and writing to Windows-side paths, reachable from WSL via `/mnt/c/`. Returns the
 * Windows user directory names found under `/mnt/c/Users/`.
 */
export function getWindowsUserDirs(): string[] {
	const dirs: string[] = [];
	if (!isWSL()) { return dirs; }
	try {
		const usersPath = '/mnt/c/Users';
		if (!fs.existsSync(usersPath)) { return dirs; }
		const entries = fs.readdirSync(usersPath, { withFileTypes: true });
		const systemDirs = new Set(['public', 'default', 'default user', 'all users', 'default account']);
		for (const entry of entries) {
			if (!entry.isDirectory()) { continue; }
			const name = entry.name.toLowerCase();
			if (systemDirs.has(name)) { continue; }
			dirs.push(entry.name);
		}
	} catch {
		// /mnt/c may not be available
	}
	return dirs;
}
