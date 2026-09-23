/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * ModelMeter sidebar — a WebviewView implementation of the activity-bar view
 * (`modelMeter.main`).
 *
 * Design goals:
 *  - Clearly distinct from the original copilot-alternatives tree sidebar:
 *    brand header, weekly hero stats, proportional vendor usage bars, compact
 *    recent-session list, action buttons.
 *  - View-only: all data comes from `MetricsService`; all navigation reuses the
 *    existing `modelMeter.*` commands. No business logic is duplicated.
 *  - Security: strict CSP with a per-load nonce, no remote resources, no eval,
 *    and an explicit message-type whitelist (never executeCommand(message.…)).
 *  - Performance: the HTML is built once per view load; data updates are sent
 *    via postMessage with a debounce, so token events don't rebuild the page.
 */

import * as vscode from 'vscode';
import type { TokenUsageTracker } from './tokenUsageTracker';
import { formatTokenCount, formatCnyCompact, combineToCny } from './tokenCostEstimator';
import { formatVendorName } from './vendorDisplay';

// ─── View model sent to the webview ────────────────────────────────────────

export interface SidebarVendorRow {
	/** Raw vendor id from the database (used for navigation; display name is separate). */
	id: string;
	name: string;
	meta: string;
	pct: number;
	color: number;
}

export interface SidebarSessionRow {
	id: string;
	title: string;
	meta: string;
	right: string;
}

export interface SidebarData {
	version: string;
	generated: string;
	week: {
		tokens: string;
		requests: string;
		cost: string;
		costNote: string;
	};
	vendors: SidebarVendorRow[];
	sessions: SidebarSessionRow[];
	sessionsHint: string;
	empty: boolean;
}

const VENDOR_BAR_COLORS = 5;

function pad2(n: number): string {
	return n < 10 ? '0' + n : String(n);
}

function formatSessionStamp(ts: number): string {
	const d = new Date(ts);
	return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// ─── Provider ──────────────────────────────────────────────────────────────

/** Session list filter state shared with the toggleSessionFilter / clearSessionFilter commands. */
export interface ModelMeterSessionFilter {
	days: number;
	modelName?: string;
}

export class ModelMeterSidebarProvider implements vscode.WebviewViewProvider, vscode.Disposable {
	private _view: vscode.WebviewView | undefined;
	private _debounce: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly _tracker: TokenUsageTracker,
		private readonly _extensionVersion: string,
		private readonly _getSessionFilter: () => ModelMeterSessionFilter,
	) { }

	resolveWebviewView(view: vscode.WebviewView): void {
		this._view = view;
		view.webview.options = { enableScripts: true };

		view.webview.html = this._buildHtml(view.webview);

		view.webview.onDidReceiveMessage(msg => this._onMessage(msg));
		view.onDidChangeVisibility(() => {
			if (view.visible) {
				void this._pushData();
			}
		});

		void this._pushData();
	}

	/** Debounced data refresh — safe to call on every stored-data change. */
	notifyDataChanged(): void {
		if (this._debounce !== undefined) {
			clearTimeout(this._debounce);
		}
		this._debounce = setTimeout(() => {
			this._debounce = undefined;
			void this._pushData();
		}, 300);
	}

	dispose(): void {
		if (this._debounce !== undefined) {
			clearTimeout(this._debounce);
			this._debounce = undefined;
		}
	}

	// ── Data collection (MetricsService only — no business logic) ──────

	private async _collectData(): Promise<SidebarData> {
		const ms = this._tracker.metricsService;
		const filter = this._getSessionFilter();

		const [vendors, sessions] = await Promise.all([
			ms.getVendorBreakdown7d(),
			ms.listSessions(filter.days, { modelName: filter.modelName }),
		]);

		const totalTokens = vendors.reduce((s, v) => s + v.totalTokens, 0);
		const totalRequests = vendors.reduce((s, v) => s + v.requestCount, 0);
		const totalCost = vendors.reduce((s, v) => s + combineToCny(v.costUsd, v.costCny), 0);
		const totalUnpriced = vendors.reduce((s, v) => s + v.unpricedCount, 0);

		const maxTokens = Math.max(1, ...vendors.map(v => v.totalTokens));
		const vendorRows: SidebarVendorRow[] = vendors
			.filter(v => v.totalTokens > 0)
			.sort((a, b) => b.totalTokens - a.totalTokens || b.requestCount - a.requestCount)
			.map((v, i) => ({
				id: v.vendor,
				name: formatVendorName(v.vendor),
				meta: `${formatTokenCount(v.totalTokens)} · ${v.requestCount} 次`,
				pct: Math.max(2, Math.round((v.totalTokens / maxTokens) * 100)),
				color: i % VENDOR_BAR_COLORS,
			}));

		const sessionRows: SidebarSessionRow[] = [...sessions]
			.sort((a, b) => b.creation_date - a.creation_date)
			.map(s => {
				const cost = combineToCny(s.costUsd, s.costCny);
				const title = s.session_model_name
					|| formatVendorName(s.session_vendor);
				return {
					id: s.session_id,
					title,
					meta: `${s.turnCount} 轮 · ${formatSessionStamp(s.creation_date)}`,
					right: cost > 0 ? formatCnyCompact(cost) : '',
				};
			});

		const now = new Date();
		const parseIncomplete = totalRequests > 0 && totalUnpriced >= totalRequests;
		const rangeLabel = filter.days >= 3650 ? '全部时间' : `近 ${filter.days} 天`;
		const sessionsHint = filter.modelName ? `${rangeLabel} · ${filter.modelName}` : rangeLabel;

		return {
			version: this._extensionVersion,
			generated: `${pad2(now.getHours())}:${pad2(now.getMinutes())}`,
			week: {
				tokens: formatTokenCount(totalTokens),
				requests: String(totalRequests),
				cost: parseIncomplete && totalCost === 0 ? '—' : formatCnyCompact(totalCost),
				costNote: '官方 API 原价',
			},
			vendors: vendorRows,
			sessions: sessionRows,
			sessionsHint,
			empty: vendorRows.length === 0 && sessionRows.length === 0,
		};
	}

	private async _pushData(): Promise<void> {
		if (!this._view) { return; }
		try {
			const data = await this._collectData();
			await this._view.webview.postMessage({ type: 'data', payload: data });
		} catch {
			// Never let a data hiccup take down the sidebar.
		}
	}

	// ── Message whitelist (webview → host) ─────────────────────────────

	private _onMessage(msg: unknown): void {
		if (!msg || typeof msg !== 'object') { return; }
		const type = (msg as { type?: unknown }).type;
		switch (type) {
			case 'ready':
				void this._pushData();
				break;
			case 'openOverview':
				void vscode.commands.executeCommand('modelMeter.showTokenUsage');
				break;
			case 'openVendor': {
				const vendorId = (msg as { vendorId?: unknown }).vendorId;
				const safeVendor = typeof vendorId === 'string' && vendorId.length > 0 && vendorId.length < 64 && !/[<>"'&]/.test(vendorId)
					? vendorId
					: undefined;
				void vscode.commands.executeCommand('modelMeter.showVendorUsage', safeVendor);
				break;
			}
			case 'openModel':
				void vscode.commands.executeCommand('modelMeter.showModelUsage');
				break;
			case 'openSession': {
				const id = (msg as { sessionId?: unknown }).sessionId;
				if (typeof id === 'string' && id.length > 0 && id.length < 128) {
					void vscode.commands.executeCommand('modelMeter.showSessionDetail', id);
				}
				break;
			}
			case 'refresh':
				void vscode.commands.executeCommand('modelMeter.reloadTokenUsage');
				break;
			case 'openHelp':
				void vscode.commands.executeCommand('modelMeter.openHelpDoc');
				break;
			default:
				// Unknown message types are ignored on purpose.
				break;
		}
	}

	// ── HTML (built once per view load; data arrives via postMessage) ──

	private _buildHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		const csp = [
			`default-src 'none'`,
			`img-src data:`,
			`style-src 'nonce-${nonce}'`,
			`script-src 'nonce-${nonce}'`,
			`font-src 'none'`,
		].join('; ');

		return /* html */`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">
	:root {
		--mm-radius: 6px;
		--mm-track: rgba(127, 127, 127, 0.22);
	}
	* { box-sizing: border-box; }
	body {
		margin: 0;
		padding: 10px 12px 14px;
		background: var(--vscode-sideBar-background, var(--vscode-editor-background));
		color: var(--vscode-foreground);
		font-family: var(--vscode-font-family);
		font-size: 12px;
		line-height: 1.45;
		overflow-x: hidden;
	}
	.hdr {
		display: flex; align-items: baseline; justify-content: space-between;
		gap: 8px; margin-bottom: 8px;
	}
	.brand { font-size: 13px; font-weight: 600; letter-spacing: 0.2px; }
	.brand .ver { font-size: 10px; font-weight: 400; color: var(--vscode-descriptionForeground); margin-left: 4px; }
	.updated { font-size: 10px; color: var(--vscode-descriptionForeground); white-space: nowrap; }

	.hero {
		border: 1px solid var(--vscode-contrastBorder, transparent);
		background: var(--vscode-input-background, transparent);
		border-radius: var(--mm-radius);
		padding: 8px 10px 7px;
		display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px 8px;
	}
	.hero .cell { min-width: 0; }
	.hero .v {
		font-size: 15px; font-weight: 600; white-space: nowrap;
		overflow: hidden; text-overflow: ellipsis;
	}
	.hero .v.small { font-size: 13px; }
	.hero .l { font-size: 10px; color: var(--vscode-descriptionForeground); }
	.hero .l.sub { font-size: 9px; opacity: .85; margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

	.sec-h {
		display: flex; align-items: center; justify-content: space-between;
		margin: 12px 0 4px;
		font-size: 11px; font-weight: 600;
		color: var(--vscode-foreground);
	}
	.sec-h .hint { font-size: 10px; font-weight: 400; color: var(--vscode-descriptionForeground); }
	.divider { border: 0; border-top: 1px solid var(--vscode-panel-border, var(--vscode-contrastBorder, transparent)); margin: 10px 0 0; opacity: 0.7; }

	.vrow { padding: 5px 0 3px; cursor: pointer; border-radius: 4px; }
	.vrow:hover, .vrow:focus-visible { background: var(--vscode-list-hoverBackground); }
	.vrow:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
	.vrow .top { display: flex; justify-content: space-between; gap: 8px; }
	.vrow .name { flex: 1 1 auto; min-width: 0; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.vrow .meta { flex: 0 0 auto; color: var(--vscode-descriptionForeground); white-space: nowrap; font-size: 11px; }
	.track { height: 5px; border-radius: 3px; background: var(--mm-track); margin-top: 2px; overflow: hidden; }
	.fill { height: 100%; border-radius: 3px; }
	.fill.c0 { background: var(--vscode-charts-blue, #3794ff); }
	.fill.c1 { background: var(--vscode-charts-green, #89d185); }
	.fill.c2 { background: var(--vscode-charts-purple, #b180d7); }
	.fill.c3 { background: var(--vscode-charts-orange, #d18616); }
	.fill.c4 { background: var(--vscode-charts-red, #f14c4c); }

	.srow {
		display: flex; align-items: baseline; justify-content: space-between; gap: 8px;
		padding: 5px 6px; margin: 0 -6px; cursor: pointer; border-radius: 4px;
	}
	.srow:hover, .srow:focus-visible { background: var(--vscode-list-hoverBackground); }
	.srow:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
	.srow .main { min-width: 0; flex: 1 1 auto; }
	.srow .t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
	.srow .m { font-size: 10px; color: var(--vscode-descriptionForeground); }
	.srow .r { flex: 0 0 auto; font-size: 10px; color: var(--vscode-descriptionForeground); opacity: .85; white-space: nowrap; }

	.linkbtn {
		display: inline-block; margin-top: 6px; padding: 2px 0;
		color: var(--vscode-textLink-foreground); background: none; border: none;
		font-size: 11px; cursor: pointer; font-family: inherit;
	}
	.linkbtn:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }

	.btnrow { display: flex; gap: 6px; margin-top: 12px; flex-wrap: wrap; }
	.btn {
		flex: 1 1 auto; min-width: 64px;
		padding: 4px 8px; cursor: pointer; border-radius: 4px;
		font-size: 11px; font-family: inherit;
		border: 1px solid var(--vscode-contrastBorder, transparent);
		background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
		color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
		text-align: center; white-space: nowrap;
	}
	.btn:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
	.btn.primary {
		background: var(--vscode-button-background);
		color: var(--vscode-button-foreground);
	}
	.btn.primary:hover { background: var(--vscode-button-hoverBackground); }
	.btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

	.empty {
		padding: 14px 4px; text-align: center;
		color: var(--vscode-descriptionForeground); font-size: 11px;
	}
	[hidden] { display: none !important; }
</style>
</head>
<body>
	<div class="hdr">
		<div class="brand">ModelMeter<span class="ver" id="ver"></span></div>
		<div class="updated" id="updated"></div>
	</div>

	<div class="hero" id="hero">
		<div class="cell"><div class="v" id="h-tokens">–</div><div class="l">Token（近 7 天）</div></div>
		<div class="cell"><div class="v" id="h-reqs">–</div><div class="l">请求</div></div>
		<div class="cell"><div class="v small" id="h-cost">–</div><div class="l">预估费用</div><div class="l sub" id="h-cost-note">官方 API 原价</div></div>
	</div>

	<div class="sec-h"><span>模型用量</span><span class="hint">近 7 天 · 按 Token</span></div>
	<div id="vendors"></div>

	<hr class="divider">

	<div class="sec-h"><span>最近会话</span><span class="hint" id="sess-count"></span></div>
	<div id="sessions"></div>
	<button class="linkbtn" id="more-sessions" hidden>查看全部会话 →</button>

	<div class="btnrow">
		<button class="btn primary" data-msg="openOverview">用量总览</button>
		<button class="btn" data-msg="refresh">重新统计</button>
		<button class="btn" data-msg="openHelp">帮助</button>
	</div>

	<script nonce="${nonce}">
		const vscode = acquireVsCodeApi();
		const SESSION_PREVIEW = 6;
		let allSessions = [];
		let sessionsHint = '';
		let expanded = false;

		function esc(s) {
			return String(s)
				.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
				.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
		}

		function renderVendors(rows) {
			const host = document.getElementById('vendors');
			if (!rows.length) {
				host.innerHTML = '<div class="empty">暂无用量数据<br>使用 Copilot Chat 后这里会出现厂商与模型统计</div>';
				return;
			}
			host.innerHTML = rows.map(function (r) {
				// Bar width is applied later via CSSOM (el.style.width) — inline
				// style="" attributes would violate the strict style-src CSP.
				return '<div class="vrow" data-msg="openVendor" data-vendor-id="' + esc(r.id) + '" title="打开厂商用量" tabindex="0" role="button" aria-label="打开厂商用量：' + esc(r.name) + '">' +
					'<div class="top"><span class="name">' + esc(r.name) + '</span><span class="meta">' + esc(r.meta) + '</span></div>' +
					'<div class="track"><div class="fill c' + (r.color | 0) + '" data-w="' + (r.pct | 0) + '"></div></div>' +
					'</div>';
			}).join('');
			host.querySelectorAll('.fill').forEach(function (el) {
				el.style.width = (el.getAttribute('data-w') | 0) + '%';
			});
		}

		function renderSessions() {
			const host = document.getElementById('sessions');
			const count = document.getElementById('sess-count');
			const more = document.getElementById('more-sessions');
			count.textContent = allSessions.length ? (String(allSessions.length) + ' 个' + (sessionsHint ? ' · ' + sessionsHint : '')) : sessionsHint;
			if (!allSessions.length) {
				host.innerHTML = '<div class="empty">暂无会话<br>使用 Copilot Chat 后这里会出现会话记录</div>';
				more.hidden = true;
				return;
			}
			const shown = expanded ? allSessions : allSessions.slice(0, SESSION_PREVIEW);
			host.innerHTML = shown.map(function (s) {
				return '<div class="srow" data-msg="openSession" data-session-id="' + esc(s.id) + '" title="打开会话详情" tabindex="0" role="button" aria-label="打开会话详情：' + esc(s.title) + '">' +
					'<div class="main"><div class="t">' + esc(s.title) + '</div><div class="m">' + esc(s.meta) + '</div></div>' +
					'<div class="r">' + esc(s.right) + '</div>' +
					'</div>';
			}).join('');
			if (allSessions.length > SESSION_PREVIEW) {
				more.hidden = false;
				more.textContent = expanded ? '收起会话列表 ←' : ('查看全部会话（' + allSessions.length + '）→');
			} else {
				more.hidden = true;
			}
		}

		function render(data) {
			document.getElementById('ver').textContent = data.version ? 'v' + data.version : '';
			document.getElementById('updated').textContent = data.generated ? ('更新于 ' + data.generated) : '';
			document.getElementById('h-tokens').textContent = data.week.tokens;
			document.getElementById('h-reqs').textContent = data.week.requests;
			document.getElementById('h-cost').textContent = data.week.cost;
			document.getElementById('h-cost-note').textContent = data.week.costNote;
			renderVendors(data.vendors || []);
			allSessions = data.sessions || [];
			sessionsHint = data.sessionsHint || '';
			renderSessions();
		}

		window.addEventListener('message', function (ev) {
			const msg = ev.data;
			if (msg && msg.type === 'data' && msg.payload) {
				render(msg.payload);
			}
		});

		// Event delegation: data-msg attributes map to the host-side whitelist.
		document.addEventListener('click', function (ev) {
			const el = ev.target && ev.target.closest ? ev.target.closest('[data-msg]') : null;
			if (!el) { return; }
			const msg = el.getAttribute('data-msg');
			if (msg === 'openSession') {
				vscode.postMessage({ type: 'openSession', sessionId: el.getAttribute('data-session-id') || '' });
			} else if (msg === 'openVendor') {
				vscode.postMessage({ type: 'openVendor', vendorId: el.getAttribute('data-vendor-id') || '' });
			} else {
				vscode.postMessage({ type: msg });
			}
		});

		document.getElementById('more-sessions').addEventListener('click', function (ev) {
			ev.stopPropagation();
			expanded = !expanded;
			renderSessions();
		});

		// Keyboard access for vendor/session rows: Enter / Space activate the
		// same message as a click (rows are tabindex=0, role=button).
		document.addEventListener('keydown', function (ev) {
			if (ev.key !== 'Enter' && ev.key !== ' ' && ev.key !== 'Spacebar') { return; }
			var el = ev.target && ev.target.closest ? ev.target.closest('[data-msg][tabindex]') : null;
			if (!el) { return; }
			ev.preventDefault();
			el.click();
		});

		vscode.postMessage({ type: 'ready' });
	</script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let text = '';
	for (let i = 0; i < 32; i++) {
		text += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return text;
}
