/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Logging tests — normal mode must stay quiet (summaries only), debug mode
 * releases detailed messages, and the output channel is never shown implicitly.
 */

import { describe, it, expect } from 'vitest';
import { LogServiceImpl, LogLevel, ILogTarget } from '../platform/log/common/logService';
import { VSCodeLogTarget } from '../platform/log/vscode/logService';

function fakeChannel() {
	const calls: string[] = [];
	let showCount = 0;
	return {
		calls,
		get showCount() { return showCount; },
		trace: (m: string) => calls.push(`trace:${m}`),
		debug: (m: string) => calls.push(`debug:${m}`),
		info: (m: string) => calls.push(`info:${m}`),
		warn: (m: string) => calls.push(`warn:${m}`),
		error: (m: string) => calls.push(`error:${m}`),
		show: () => { showCount++; },
	};
}

function makeTarget(channel: ReturnType<typeof fakeChannel>, level?: LogLevel): VSCodeLogTarget {
	return new VSCodeLogTarget(channel as never, level);
}

describe('VSCodeLogTarget 日志分级', () => {
	it('默认（normal=Info）：info/warn/error 通过，debug/trace 被拦截', () => {
		const ch = fakeChannel();
		const target = makeTarget(ch);
		target.logIt(LogLevel.Trace, 't');
		target.logIt(LogLevel.Debug, 'd');
		target.logIt(LogLevel.Info, 'i');
		target.logIt(LogLevel.Warning, 'w');
		target.logIt(LogLevel.Error, 'e');
		expect(ch.calls).toEqual(['info:i', 'warn:w', 'error:e']);
	});

	it('setMinLevel(Debug) 后 debug 通过（供 logLevel=debug 设置与诊断使用）', () => {
		const ch = fakeChannel();
		const target = makeTarget(ch);
		target.setMinLevel(LogLevel.Debug);
		target.logIt(LogLevel.Debug, 'd');
		target.logIt(LogLevel.Info, 'i');
		expect(ch.calls).toEqual(['debug:d', 'info:i']);
	});

	it('不隐式调用 show（激活期不得自动弹出 Output 面板）', () => {
		const ch = fakeChannel();
		const target = makeTarget(ch);
		target.logIt(LogLevel.Info, 'i');
		expect(ch.showCount).toBe(0);
		// 只有显式调用才会 show
		target.show();
		expect(ch.showCount).toBe(1);
	});
});

describe('LogServiceImpl + 子日志', () => {
	function serviceWith(ch: ReturnType<typeof fakeChannel>, level = LogLevel.Info) {
		const target = makeTarget(ch, level);
		const svc = new LogServiceImpl([target]);
		return { svc, target };
	}

	it('子日志带 [Topic] 前缀，且同样受级别过滤', () => {
		const ch = fakeChannel();
		const { svc } = serviceWith(ch);
		const sub = svc.createSubLogger('Metrics');
		sub.info('sum ok');
		sub.debug('detail');
		expect(ch.calls).toEqual(['info:[Metrics] sum ok']);
	});

	it('withExtraTarget 附加目标（例如诊断模式临时提升详细目标）', () => {
		const ch = fakeChannel();
		const extraCh = fakeChannel();
		const { svc } = serviceWith(ch);
		const extra: ILogTarget = {
			logIt: (level, message) => { if (level >= LogLevel.Info) { extraCh.calls.push(message); } },
		};
		const withExtra = svc.withExtraTarget(extra);
		withExtra.info('hello');
		expect(ch.calls).toEqual(['info:hello']);
		expect(extraCh.calls).toEqual(['hello']);
	});

	it('error() 归一化 Error 对象并携带附加消息', () => {
		const ch = fakeChannel();
		const { svc } = serviceWith(ch);
		svc.error(new Error('boom'), 'ctx');
		expect(ch.calls).toEqual(['error:boom: ctx']);
	});
});
