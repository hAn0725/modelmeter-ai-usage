/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *  Adapted from feima-copilot-ai-flow logging infrastructure.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ILogTarget, LogLevel } from '../common/logService';

/**
 * Log target that writes to VS Code's LogOutputChannel.
 *
 * Messages below `minLevel` are dropped here (not just by the channel's own
 * level), so the default "normal" mode stays quiet: summaries + warnings +
 * errors only. Set `modelMeter.logLevel = "debug"` (or call
 * `setMinLevel`) to surface detailed diagnostics.
 */
export class VSCodeLogTarget implements ILogTarget {
	private _minLevel: LogLevel;

	constructor(private readonly _channel: vscode.LogOutputChannel, minLevel: LogLevel = LogLevel.Info) {
		this._minLevel = minLevel;
	}

	/** Changes the minimum level for subsequent messages (config change / debug toggle). */
	setMinLevel(level: LogLevel): void {
		this._minLevel = level;
	}

	logIt(level: LogLevel, message: string): void {
		if (level < this._minLevel) { return; }
		switch (level) {
			case LogLevel.Trace: this._channel.trace(message); break;
			case LogLevel.Debug: this._channel.debug(message); break;
			case LogLevel.Info: this._channel.info(message); break;
			case LogLevel.Warning: this._channel.warn(message); break;
			case LogLevel.Error: this._channel.error(message); break;
		}
	}

	show(preserveFocus?: boolean): void {
		this._channel.show(preserveFocus);
	}
}

/**
 * Console log target. In production, only emits errors by default.
 */
export class ConsoleLogTarget implements ILogTarget {
	constructor(
		private readonly prefix?: string,
		private readonly minLogLevel: LogLevel = LogLevel.Warning,
	) {}

	logIt(level: LogLevel, message: string): void {
		const msg = this.prefix ? `${this.prefix}${message}` : message;
		if (level === LogLevel.Error) { console.error(msg); }
		else if (level === LogLevel.Warning) { console.warn(msg); }
		else if (level >= this.minLogLevel) { console.log(msg); }
	}
}
