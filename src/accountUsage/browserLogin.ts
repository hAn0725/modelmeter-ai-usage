/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared BrowserLoginService (CDP, zero bundled browser).
 *
 * Architecture follows the verified Buggo404/mimo-usage-monitor approach:
 *  - launch the user's existing Chrome/Edge with `--remote-debugging-port` and
 *    a throwaway `--user-data-dir` (nothing of the user's profile is touched)
 *  - drive the login page via CDP over WebSocket
 *  - poll `Network.getCookies` until the session is usable
 *  - kill the browser, delete the temp profile, return the Cookie header
 *
 * Uses the runtime's built-in `WebSocket` (VS Code ≥ 1.90 ships Node ≥ 20
 * with a global WebSocket). When unavailable, callers fall back to the manual
 * cookie path — no `ws`/Playwright/Puppeteer dependency is added.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';

export interface BrowserLoginRequest {
	/** Sign-in page opened in the throwaway profile. */
	loginUrl: string;
	/** Cookie domains collected after sign-in. */
	domains: string[];
	/** When non-empty: success once all of these cookies exist. */
	cookieNames: string[];
	/** Alternative success check (e.g. call the provider's user-info API). */
	verify?: (cookieHeader: string) => Promise<boolean>;
	onProgress?: (message: string) => void;
	/** Default 5 minutes. */
	timeoutMs?: number;
}

export class BrowserLoginUnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'BrowserLoginUnsupportedError';
	}
}

const POLL_INTERVAL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function findBrowserPath(): string | undefined {
	const candidates: string[] = [];
	if (process.platform === 'win32') {
		const pf = process.env.PROGRAMFILES || 'C:\\Program Files';
		const pf86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
		candidates.push(
			path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
			path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
			path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
			path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
		);
	} else if (process.platform === 'darwin') {
		candidates.push(
			'/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
			'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
		);
	} else {
		candidates.push(
			'/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable',
			'/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
		);
	}
	for (const candidate of candidates) {
		try { if (fs.existsSync(candidate)) { return candidate; } } catch { /* keep looking */ }
	}
	return undefined;
}

interface CdpTarget { id?: string; type?: string; url?: string; webSocketDebuggerUrl?: string }

function httpJson(url: string, method = 'GET'): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const req = http.request(url, { method }, (res) => {
			let data = '';
			res.on('data', chunk => { data += chunk; });
			res.on('end', () => {
				try { resolve(JSON.parse(data)); } catch { reject(new Error('非 JSON 响应')); }
			});
		});
		req.on('error', reject);
		req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
		req.end();
	});
}

async function listTargets(port: number): Promise<CdpTarget[] | null> {
	try {
		const result = await httpJson(`http://127.0.0.1:${port}/json`);
		return Array.isArray(result) ? (result as CdpTarget[]) : null;
	} catch {
		return null;
	}
}

/** Minimal CDP client over the runtime's global WebSocket. */
class CdpSession {
	private _nextId = 1;
	private readonly _pending = new Map<number, (msg: { result?: unknown; error?: { message?: string } }) => void>();

	private constructor(private readonly _socket: WebSocket) {
		this._socket.addEventListener('message', (event: { data: unknown }) => {
			try {
				const msg = JSON.parse(String((event as { data: unknown }).data)) as { id?: number; result?: unknown; error?: { message?: string } };
				if (msg.id != null && this._pending.has(msg.id)) {
					this._pending.get(msg.id)!(msg);
					this._pending.delete(msg.id);
				}
			} catch { /* ignore non-JSON frames */ }
		});
	}

	static connect(wsUrl: string, timeoutMs = 10000): Promise<CdpSession> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(wsUrl);
			const timer = setTimeout(() => { try { socket.close(); } catch { /* ignore */ } reject(new Error('CDP 连接超时')); }, timeoutMs);
			socket.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpSession(socket)); });
			socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP 连接失败')); });
		});
	}

	send(method: string, params?: Record<string, unknown>): Promise<{ result?: unknown; error?: { message?: string } }> {
		return new Promise((resolve, reject) => {
			const id = this._nextId++;
			const timer = setTimeout(() => { this._pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }, 10000);
			this._pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
			try {
				this._socket.send(JSON.stringify({ id, method, params }));
			} catch (err) {
				clearTimeout(timer);
				this._pending.delete(id);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		});
	}

	close(): void {
		try { this._socket.close(); } catch { /* ignore */ }
	}
}

/** Poll `Network.getCookies` for the request's domains. */
export async function collectCookies(session: CdpSession, domains: string[]): Promise<{ name: string; value: string }[]> {
	const response = await session.send('Network.getCookies', { urls: domains });
	const cookies = (response.result as { cookies?: Array<{ name?: string; value?: string }> } | undefined)?.cookies ?? [];
	return cookies
		.filter(c => typeof c.name === 'string' && typeof c.value === 'string')
		.map(c => ({ name: c.name as string, value: c.value as string }));
}

export function cookieHeaderFrom(cookies: Array<{ name: string; value: string }>): string {
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const cookie of cookies) {
		if (seen.has(cookie.name)) { continue; }
		seen.add(cookie.name);
		parts.push(`${cookie.name}=${cookie.value}`);
	}
	return parts.join('; ');
}

async function waitForSuccess(session: CdpSession, request: BrowserLoginRequest, deadline: number): Promise<string | null> {
	// eslint-disable-next-line no-constant-condition
	while (true) {
		if (Date.now() > deadline) { return null; }
		try {
			const cookies = await collectCookies(session, request.domains);
			if (cookies.length > 0) {
				const header = cookieHeaderFrom(cookies);
				if (request.cookieNames.length > 0) {
					if (request.cookieNames.every(name => cookies.some(c => c.name === name))) {
						return header;
					}
				} else if (request.verify) {
					try {
						if (await request.verify(header)) { return header; }
					} catch { /* not usable yet */ }
				} else {
					return header;
				}
			}
		} catch { /* chrome not ready yet */ }
		await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
	}
}

function killBrowser(child: { pid?: number; kill(): boolean }): void {
	try {
		if (process.platform === 'win32' && child.pid) {
			// Kill the whole browser process tree (renderers survive a plain kill).
			spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
		} else {
			child.kill();
		}
	} catch { /* ignore */ }
}

function cleanupProfile(dir: string): void {
	try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* ignore */ }
}

/**
 * Run the shared login flow. Throws BrowserLoginUnsupportedError when the
 * environment cannot do CDP (caller should fall back to manual cookies).
 */
export async function browserLogin(request: BrowserLoginRequest): Promise<string> {
	const browserPath = findBrowserPath();
	if (!browserPath) {
		throw new BrowserLoginUnsupportedError('未找到本机 Chrome / Edge 浏览器，请使用手动 Cookie 方式。');
	}
	if (typeof WebSocket !== 'function') {
		throw new BrowserLoginUnsupportedError('当前 VS Code 运行时不支持内置 WebSocket（需要 VS Code 1.90+ 或 Node 20+），请使用手动 Cookie 方式。');
	}

	const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'modelmeter-login-'));
	const port = 9200 + Math.floor(Math.random() * 100);
	request.onProgress?.(`正在启动浏览器（临时配置目录）…`);
	const child = spawn(browserPath, [
		`--remote-debugging-port=${port}`,
		`--user-data-dir=${profileDir}`,
		'--no-first-run',
		'--no-default-browser-check',
		'--new-window',
		request.loginUrl,
	], { stdio: 'ignore', detached: false });

	const deadline = Date.now() + (request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
	try {
		// Wait for the debugging endpoint.
		let target: CdpTarget | undefined;
		while (Date.now() < deadline) {
			const targets = await listTargets(port);
			if (targets) {
				target = targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl && matchesDomain(t.url, request))
					?? targets.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
				if (target?.webSocketDebuggerUrl) { break; }
			}
			await new Promise(resolve => setTimeout(resolve, 500));
		}
		if (!target?.webSocketDebuggerUrl) {
			throw new Error('浏览器调试端口未就绪');
		}

		request.onProgress?.('请在浏览器中完成登录…');
		const session = await CdpSession.connect(target.webSocketDebuggerUrl);
		try {
			try { await session.send('Network.enable'); } catch { /* optional */ }
			const header = await waitForSuccess(session, request, deadline);
			if (!header) {
				throw new Error('等待登录超时，请重试或使用手动 Cookie 方式。');
			}
			return header;
		} finally {
			session.close();
		}
	} finally {
		killBrowser(child);
		// Give the browser a moment to release file locks on Windows.
		await new Promise(resolve => setTimeout(resolve, 500));
		cleanupProfile(profileDir);
	}
}

function matchesDomain(url: string | undefined, request: BrowserLoginRequest): boolean {
	if (!url) { return false; }
	try {
		const host = new URL(url).host;
		return request.domains.some(domain => {
			try { return new URL(domain).host === host; } catch { return false; }
		});
	} catch {
		return false;
	}
}
