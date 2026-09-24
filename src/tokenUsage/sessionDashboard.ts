/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { TokenUsageTracker } from './tokenUsageTracker';
import { SessionDetail, TurnRow } from './metricsDatabase';
import { formatTokenCount, combineToCny } from './tokenCostEstimator';
import { formatCnyUi, AMOUNT_FMT_JS } from './amountFormat';
import { aggregateSessionContext } from './contextBreakdown';
import { formatVendorName } from './vendorDisplay';
import { getNonce, webviewCsp, webviewPlaceholder } from './webviewCsp';

// ─── Formatting helpers ─────────────────────────────────────────────────────

function formatMs(ms: number | null): string {
	if (ms === null || ms === undefined) { return '—'; }
	if (ms < 1000) { return `${ms}ms`; }
	if (ms < 60000) { return `${(ms / 1000).toFixed(1)}s`; }
	const m = Math.floor(ms / 60000);
	const s = Math.floor((ms % 60000) / 1000);
	return `${m}m ${s}s`;
}

function pad2(n: number): string { return n < 10 ? '0' + n : String(n); }

/** Local-time `YYYY-MM-DD HH:mm:ss` (previously UTC via toISOString). */
function formatDate(ts: number): string {
	const d = new Date(ts);
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Local-time `HH:mm:ss`. */
function formatTime(ts: number): string {
	const d = new Date(ts);
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// ─── Dashboard Panel ─────────────────────────────────────────────────────────

export class SessionDashboard {
	static readonly viewType = 'modelMeter.session';
	static currentPanel: SessionDashboard | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _disposables: vscode.Disposable[] = [];
	private _sessionId: string;

	private constructor(
		panel: vscode.WebviewPanel,
		private readonly _tracker: TokenUsageTracker,
		sessionId: string,
	) {
		this._sessionId = sessionId;
		this._panel = panel;
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.onDidReceiveMessage(msg => {
			if (msg.type === 'reload') {
				vscode.commands.executeCommand('modelMeter.reloadTokenUsage');
			}
		}, null, this._disposables);
	}

	static createOrShow(tracker: TokenUsageTracker, sessionId: string): SessionDashboard {
		const col = vscode.window.activeTextEditor?.viewColumn;
		if (SessionDashboard.currentPanel) {
			SessionDashboard.currentPanel._panel.reveal(col);
			SessionDashboard.currentPanel._sessionId = sessionId;
			return SessionDashboard.currentPanel;
		}
		const panel = vscode.window.createWebviewPanel(
			SessionDashboard.viewType,
			'会话详情',
			col ?? vscode.ViewColumn.One,
			{ retainContextWhenHidden: true },
		);
		// CSP-first (see webviewCsp.ts): prime a CSP-carrying document before
		// enabling scripts, otherwise VS Code logs a missing-CSP warning.
		panel.webview.html = webviewPlaceholder();
		panel.webview.options = { enableScripts: true };
		SessionDashboard.currentPanel = new SessionDashboard(panel, tracker, sessionId);
		return SessionDashboard.currentPanel;
	}

	update(): void {
		void this._renderAsync().then(html => {
			this._panel.webview.html = html;
		}).catch(() => { /* ignore render errors */ });
	}

	// ─── HTML Generation ───────────────────────────────────────────────

	private async _renderAsync(): Promise<string> {
		const detail = await this._tracker.metricsService.getSessionDetail(this._sessionId);
		if (!detail) {
			return this._renderEmpty();
		}
		return this._renderDetail(detail);
	}

	private _renderEmpty(): string {
		const nonce = getNonce();
		return /* html */`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="${webviewCsp(nonce)}"><title>未找到会话</title>
<style>${this._sharedCss()}</style></head>
<body><h1>未找到会话</h1>
<p class="subtitle">在数据库中未找到会话 <strong>${this._sessionId}</strong>。</p>
</body></html>`;
	}

	private _renderDetail(detail: SessionDetail): string {
		const nonce = getNonce();
		const s = detail.session;
		const turns = detail.turns;

		// ── Overview stats ──────────────────────────────────────────────
		const dateStr = s.creation_date ? formatDate(s.creation_date) : 'N/A';
		const vendorModel = [s.session_vendor ? formatVendorName(s.session_vendor) : null, s.session_model_name].filter(Boolean).join(' / ') || 'Unknown';
		const totalPrompt = turns.reduce((sum, t) => sum + t.prompt_tokens, 0);
		const totalCompletion = turns.reduce((sum, t) => sum + t.completion_tokens, 0);
		const totalCost = turns.reduce((sum, t) => sum + combineToCny(t.estimated_cost_usd, t.estimated_cost_cny), 0);
		const allTurnsUnpriced = turns.length > 0 && turns.every(t => t.estimated_cost_usd == null && t.estimated_cost_cny == null);
		const totalElapsed = turns.reduce((sum, t) => sum + (t.total_elapsed_ms ?? 0), 0);
		const timeRange = turns.length > 0
			? `${formatTime(turns[0].timestamp)} → ${formatTime(turns[turns.length - 1].timestamp)}`
			: '';
		const pendingLabel = s.has_pending_edits ? '⚠ 存在未应用的编辑' : '';

		// ── Session-level input-context aggregate (prompt-token weighted) ──
		const ctxAgg = aggregateSessionContext(turns);
		const CTX_META: Array<{ key: string; label: string; cls: string }> = [
			{ key: 'system', label: '系统指令', cls: 's' },
			{ key: 'tools', label: '工具定义', cls: 't' },
			{ key: 'messages', label: '对话消息', cls: 'm' },
			{ key: 'files', label: '文件上下文', cls: 'f' },
			{ key: 'toolResults', label: '工具结果', cls: 'r' },
		];
		const ctxCats = CTX_META.map(meta => {
			const c = ctxAgg.categories.find(x => x.key === meta.key);
			return { ...meta, pct: c?.pct ?? 0, tokens: c?.tokens ?? 0 };
		}).filter(c => c.pct >= 0.05);
		const ctxSumPct = ctxCats.reduce((sum, c) => sum + c.pct, 0);
		const ctxCoverageNote = ctxAgg.hasData && ctxAgg.coverage < 0.9995
			? `构成数据覆盖 ${(ctxAgg.coverage * 100).toFixed(1)}% 输入 Token`
			: '';

		// ── Turns table rows (JSON for script) ─────────────────────────
		const turnRows = turns.map((t, i) => ({
			idx: i + 1,
			time: formatTime(t.timestamp),
			model: t.resolved_model ? t.resolved_model.split('/').pop() : (t.model_name ?? t.model_id.split('/').pop()),
			vendor: formatVendorName(t.vendor),
			modelId: t.model_id,
			prompt: t.prompt_tokens,
			completion: t.completion_tokens,
			cost: (t.estimated_cost_usd == null && t.estimated_cost_cny == null) ? null : combineToCny(t.estimated_cost_usd, t.estimated_cost_cny),
			toolRounds: t.tool_call_rounds,
			toolCalls: t.tool_call_count,
			files: t.edited_file_count,
			ttfb: t.first_progress_ms,
			elapsed: t.total_elapsed_ms,
			sysPct: t.system_instructions_pct,
			toolPct: t.tool_definitions_pct,
			msgPct: t.messages_pct,
			filePct: t.files_pct,
			toolResPct: t.tool_results_pct,
			vote: t.vote,
		}));

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${webviewCsp(nonce)}">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>会话详情 — ${s.session_id.substring(0, 8)}</title>
<style>${this._sharedCss()}
/* Session-specific styles */
.cell-model{font-size:11px;white-space:nowrap}
.sort-asc::after{content:' ▲';font-size:8px}
.sort-desc::after{content:' ▼';font-size:8px}
.empty{text-align:center;padding:40px;color:var(--muted)}
.pbar{display:flex;gap:1px;width:70px;height:10px;border-radius:3px;overflow:hidden;background:var(--bg);vertical-align:middle}
.pbar span{display:inline-block;height:100%}
.pbar-s{background:rgba(139,92,246,.7)}
.pbar-t{background:rgba(59,130,246,.7)}
.pbar-m{background:rgba(16,185,129,.7)}
.pbar-f{background:rgba(249,115,22,.7)}
.pbar-r{background:rgba(239,68,68,.7)}

/* Session-level input-context panel */
.ctx-bar{display:flex;height:18px;border-radius:5px;overflow:hidden;background:var(--bg);margin-bottom:10px}
.ctx-seg{height:100%;min-width:2px}
.ctx-legend{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:11px}
.ctx-item{display:inline-flex;align-items:center;gap:6px}
.ctx-dot{width:8px;height:8px;border-radius:2px;display:inline-block}
.ctx-pct{color:var(--muted)}
.ctx-seg.s,.ctx-dot.s{background:rgba(139,92,246,.8)}
.ctx-seg.t,.ctx-dot.t{background:rgba(59,130,246,.8)}
.ctx-seg.m,.ctx-dot.m{background:rgba(16,185,129,.8)}
.ctx-seg.f,.ctx-dot.f{background:rgba(249,115,22,.8)}
.ctx-seg.r,.ctx-dot.r{background:rgba(239,68,68,.8)}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <h1>会话详情</h1>
    <p class="subtitle">
      <strong>${s.session_id}</strong> · ${dateStr} · ${vendorModel}
      ${pendingLabel ? `· <span style="color:var(--accent)">${pendingLabel}</span>` : ''}
      · <a href="#" onclick="_vscode.postMessage({type:'reload'});return false" style="color:var(--accent);text-decoration:none" title="从本地会话文件重新构建统计数据">↻ 重新构建统计数据</a>
    </p>
  </div>
</div>

<div class="grid5">
  <div class="card">
    <div class="lbl">日期</div>
    <div class="val" style="font-size:16px">${dateStr.split(' ')[0]}</div>
    <div class="det">${s.session_family ?? ''} ${s.session_extension ?? ''}</div>
  </div>
  <div class="card">
    <div class="lbl">模型</div>
    <div class="val" style="font-size:14px">${vendorModel}</div>
    <div class="det">${s.session_is_byok ? 'BYOK' : '内置'}</div>
  </div>
  <div class="card">
    <div class="lbl">轮次</div>
    <div class="val">${turns.length}</div>
    <div class="det">${timeRange}</div>
  </div>
  <div class="card">
    <div class="lbl">Token</div>
    <div class="val">${formatTokenCount(totalPrompt + totalCompletion)}</div>
    <div class="det">输入 ${formatTokenCount(totalPrompt)} / 输出 ${formatTokenCount(totalCompletion)}</div>
  </div>
  <div class="card">
    <div class="lbl">等效 API 成本</div>
    <div class="val">${allTurnsUnpriced ? '暂无价格' : formatCnyUi(totalCost)}</div>
    <div class="det">总耗时 ${formatMs(totalElapsed)}</div>
  </div>
</div>

<!-- Session-level input-context breakdown (prompt-token weighted) -->
<div class="sec">
  <div class="sec-h">
    <div class="sec-t">输入上下文构成（整个会话）</div>
    <span style="font-size:10px;color:var(--muted)">${ctxAgg.hasData ? ('按输入 Token 加权聚合' + (ctxCoverageNote ? ' · ' + ctxCoverageNote : '')) : ''}</span>
  </div>
  ${ctxAgg.hasData ? `
  <div class="ctx-bar">${ctxCats.map(c => `<span class="ctx-seg ${c.cls}" title="约 ${formatTokenCount(Math.round(c.tokens))} Token · ${c.pct.toFixed(1)}%" style="width:${ctxSumPct > 0 ? (c.pct / ctxSumPct * 100).toFixed(2) : 0}%"></span>`).join('')}</div>
  <div class="ctx-legend">${ctxCats.map(c => `<span class="ctx-item" title="约 ${formatTokenCount(Math.round(c.tokens))} Token · ${c.pct.toFixed(1)}%"><span class="ctx-dot ${c.cls}"></span>${c.label}<span class="ctx-pct">${c.pct.toFixed(1)}%</span></span>`).join('')}</div>
  ` : '<div class="empty">暂无输入上下文构成数据。</div>'}
</div>

<div class="sec">
  <div class="sec-h">
    <div class="sec-t">轮次（${turns.length}）</div>
  </div>
  ${turns.length === 0 ? `<div class="empty">此会话中没有包含 Token 数据的轮次。</div>` : `
  <div style="overflow-x:auto">
  <table class="tbl" id="turnTable">
    <thead>
      <tr>
        <th data-sort="idx" class="sorted sort-asc">#</th>
        <th data-sort="time">时间</th>
        <th data-sort="model">模型</th>
        <th data-sort="prompt">输入</th>
        <th data-sort="completion">输出</th>
        <th>输入上下文构成</th>
        <th data-sort="cost">等效 API 成本</th>
        <th data-sort="toolCalls">工具调用</th>
        <th data-sort="files">文件</th>
        <th data-sort="ttfb">首次响应耗时</th>
        <th data-sort="elapsed">总耗时</th>
      </tr>
    </thead>
    <tbody id="turnBody"></tbody>
  </table>
  </div>`}
</div>

<script nonce="${nonce}">${AMOUNT_FMT_JS}
const turns = ${JSON.stringify(turnRows)};

function formatToks(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(0)+'K';
  return String(n);
}

function formatElapsed(ms) {
  if (!ms && ms !== 0) return '—';
  if (ms < 1000) return ms + 'ms';
  if (ms < 60000) return (ms/1000).toFixed(1) + 's';
  var m = Math.floor(ms / 60000);
  var s = Math.floor((ms % 60000) / 1000);
  return m + 'm ' + s + 's';
}

function _promptBar(t) {
  var segs = [
    {v:t.sysPct||0, c:'pbar-s', lbl:'系统'},
    {v:t.toolPct||0, c:'pbar-t', lbl:'工具'},
    {v:t.msgPct||0, c:'pbar-m', lbl:'消息'},
    {v:t.filePct||0, c:'pbar-f', lbl:'文件'},
    {v:t.toolResPct||0, c:'pbar-r', lbl:'结果'}
  ].filter(function(s){return s.v>0});
  if (segs.length===0) return '—';
  var total = segs.reduce(function(s,x){return s+x.v},0);
  var html = '<span class="pbar" title="' + segs.map(function(s){return s.lbl+':'+s.v+'%'}).join(', ') + '">';
  for (var i=0; i<segs.length; i++) {
    var w = total>0 ? Math.max(2,(segs[i].v/total)*100) : 0;
    html += '<span class="' + segs[i].c + '" style="width:' + w + '%"></span>';
  }
  html += '</span>';
  return html;
}

function renderTable(data) {
  var html = '';
  for (var i = 0; i < data.length; i++) {
    var t = data[i];
    var vendorModel = (t.vendor ? t.vendor + ' / ' : '') + (t.model || t.modelId || '');
    html += '<tr>' +
      '<td>' + t.idx + '</td>' +
      '<td>' + t.time + '</td>' +
      '<td class="cell-model" title="' + (t.modelId || '') + '">' + vendorModel + '</td>' +
      '<td>' + formatToks(t.prompt) + '</td>' +
      '<td>' + formatToks(t.completion) + '</td>' +
      '<td>' + _promptBar(t) + '</td>' +
      '<td>' + (t.cost != null && t.cost > 0 ? fmtCnyUi(t.cost) : '—') + '</td>' +
      '<td title="' + (t.toolCalls > 0 ? '共 ' + t.toolCalls + ' 次工具调用，' + t.toolRounds + ' 轮' : '无工具调用') + '">' + (t.toolCalls > 0 ? t.toolCalls + ' / ' + t.toolRounds + '轮' : '—') + '</td>' +
      '<td>' + (t.files > 0 ? t.files : '—') + '</td>' +
      '<td>' + formatElapsed(t.ttfb) + '</td>' +
      '<td>' + formatElapsed(t.elapsed) + '</td>' +
    '</tr>';
  }
  document.getElementById('turnBody').innerHTML = html;
}

// ── VS Code API ──
const _vscode = acquireVsCodeApi();

// Initial render
renderTable(turns);

// Sorting
var sortCol = 'idx';
var sortDir = 1; // 1 = asc, -1 = desc

document.getElementById('turnTable').querySelector('thead').addEventListener('click', function(e) {
  var th = e.target.closest('th');
  if (!th || !th.dataset.sort) return;
  var col = th.dataset.sort;

  // Remove sort classes
  this.querySelectorAll('th').forEach(function(h) { h.classList.remove('sorted','sort-asc','sort-desc'); });

  if (col === sortCol) {
    sortDir = -sortDir; // toggle direction
  } else {
    sortCol = col;
    sortDir = 1; // new column: ascending first
  }

  // Highlight sorted column
  th.classList.add('sorted');
  th.classList.add(sortDir === 1 ? 'sort-asc' : 'sort-desc');

  // Sort
  var sorted = turns.slice().sort(function(a, b) {
    var av = a[col], bv = b[col];
    if (typeof av === 'string') { return av.localeCompare(String(bv)) * sortDir; }
    return (av - bv) * sortDir;
  });

  // Keep original turn numbers ("#" = original order, never re-numbered)
  renderTable(sorted);
});
</script>
</body>
</html>`;
	}

	private _sharedCss(): string {
		return `
:root {
  --bg: var(--vscode-editor-background,#1e1e1e);
  --card: var(--vscode-editorWidget-background,#252526);
  --text: var(--vscode-editor-foreground,#ccc);
  --muted: var(--vscode-descriptionForeground,#888);
  --border: var(--vscode-widget-border,#404040);
  --accent: #f97316;
  --green: #10b981;
  --blue: #3b82f6;
  --purple: #8b5cf6;
  --red: #ef4444;
  --font: var(--vscode-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);
}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:var(--font);background:var(--bg);color:var(--text);padding:20px 28px;line-height:1.5;overflow-x:hidden}
h1{font-size:20px;font-weight:700;margin-bottom:4px}
.subtitle{color:var(--muted);font-size:12px;margin-bottom:20px}

.hdr{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px}

.grid5{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:20px}
@media(max-width:800px){.grid5{grid-template-columns:repeat(2,1fr)}}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 16px}
.card .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:4px}
.card .val{font-size:22px;font-weight:700}
.card .det{font-size:10px;color:var(--muted);margin-top:2px}

.sec{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:18px;margin-bottom:14px}
.sec-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.sec-t{font-size:14px;font-weight:600}

.tbl{width:100%;border-collapse:collapse}
.tbl th{font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);padding:8px 10px;text-align:left;border-bottom:1px solid var(--border);cursor:pointer;user-select:none}
.tbl th.sorted{color:var(--accent)}
.tbl td{font-size:11px;padding:6px 10px;border-bottom:1px solid var(--border);white-space:nowrap}
.tbl tbody tr:hover{background:rgba(255,255,255,.03)}

.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}`;
	}

	private dispose(): void {
		SessionDashboard.currentPanel = undefined;
		this._panel.dispose();
		for (const d of this._disposables) { d.dispose(); }
	}
}
