/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { TokenUsageTracker } from './tokenUsageTracker';
import { formatTokenCount, formatCnyCompact, combineToCny, estimateEnergy, estimateCO2Grams, formatEnergy, formatCO2, localDateKey } from './tokenCostEstimator';
import { formatCnyUi, AMOUNT_FMT_JS } from './amountFormat';
import { formatVendorName } from './vendorDisplay';
import { getNonce, webviewCsp, webviewPlaceholder } from './webviewCsp';

// ─── Vendor color palette ─────────────────────────────────────────────────────

const VENDOR_COLORS: Record<string, string> = {
	feima: '#ec4899',     // Pink
	copilot: '#34d399',    // Emerald
	openai: '#10b981',     // Green
	anthropic: '#c084fc',  // Purple
	google: '#4285f4',     // Google Blue
	deepseek: '#6366f1',   // Indigo
	zhipu: '#f59e0b',      // Amber
	moonshot: '#14b8a6',   // Teal
	baidu: '#ef4444',      // Red
	unknown: '#94a3b8',    // Slate
};

function vendorColor(vendor: string): string {
	return VENDOR_COLORS[vendor] ?? VENDOR_COLORS['unknown'];
}

/** Derive vendor from a model ID for coloring the vendor+model chart. */
function vendorForModel(modelId: string): string {
	const slash = modelId.indexOf('/');
	if (slash > 0) { return modelId.substring(0, slash); }
	return 'unknown';
}

// ─── Chart.js loading ────────────────────────────────────────────────────────

let _chartJs: string | null = null;

function chartJsSource(): string {
	if (_chartJs) { return _chartJs; }
	// __dirname = out/tokenUsage/ → .. = out/ → .. = project root
	const candidates = [
		path.join(__dirname, '..', '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js'),
	];
	try { candidates.push(require.resolve('chart.js/dist/chart.umd.min.js')); } catch { /* optional */ }
	for (const p of candidates) {
		try { if (fs.existsSync(p)) { _chartJs = fs.readFileSync(p, 'utf8'); return _chartJs; } } catch { /* try next */ }
	}
	return '/* Chart.js not found */';
}

// ─── Dashboard Panel ─────────────────────────────────────────────────────────

export class TokenUsageDashboard {
	static readonly viewType = 'modelMeter.overview';
	/** The currently open dashboard panel, if any. */
	static currentPanel: TokenUsageDashboard | undefined;

	private readonly _panel: vscode.WebviewPanel;
	private readonly _disposables: vscode.Disposable[] = [];
	private _days = 30;
	private _rangeMode: 'week' | 'month' | 'since' = 'month';
	private _sinceDate = '';

	private constructor(panel: vscode.WebviewPanel, private readonly _tracker: TokenUsageTracker) {
		this._panel = panel;
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.onDidReceiveMessage(msg => {
			if (msg.type === 'reload') {
				void vscode.commands.executeCommand('modelMeter.reloadTokenUsage');
				return;
			}
			if (msg.type === 'dateChange') {
				this._days = msg.days ?? 30;
				this._rangeMode = msg.mode ?? 'month';
				this._sinceDate = msg.sinceDate ?? '';
				this.update();
			}
			if (msg.type === 'runCommand') {
				void vscode.commands.executeCommand(msg.command);
			}
		}, null, this._disposables);
	}

	static createOrShow(tracker: TokenUsageTracker): TokenUsageDashboard {
		const col = vscode.window.activeTextEditor?.viewColumn;
		if (TokenUsageDashboard.currentPanel) {
			TokenUsageDashboard.currentPanel._panel.reveal(col);
			return TokenUsageDashboard.currentPanel;
		}
		const panel = vscode.window.createWebviewPanel(
			TokenUsageDashboard.viewType,
			'Token Usage',
			col ?? vscode.ViewColumn.One,
			{ retainContextWhenHidden: true }
		);
		// CSP-first (see webviewCsp.ts): prime a CSP-carrying document before
		// enabling scripts, otherwise VS Code logs a missing-CSP warning.
		panel.webview.html = webviewPlaceholder();
		panel.webview.options = { enableScripts: true };
		TokenUsageDashboard.currentPanel = new TokenUsageDashboard(panel, tracker);
		return TokenUsageDashboard.currentPanel;
	}

	update(): void {
		void this._renderAsync().then(html => {
			this._panel.webview.html = html;
		}).catch(() => { /* ignore render errors */ });
	}

	// ─── HTML Generation ───────────────────────────────────────────────

	private async _renderAsync(): Promise<string> {
		const nonce = getNonce();
		// Pull from SQLite DB (fast aggregation query)
		const s = await this._tracker.metricsService.getDashboardSummary(this._days);

		// Vendor aggregates (cost/request totals straight from the DB)
		const vendorEntries = s.vendorBreakdown
			.map(v => [v.vendor, { promptTokens: v.promptTokens, completionTokens: v.completionTokens, cost: combineToCny(v.costUsd, v.costCny), requestCount: v.requestCount, unpricedCount: v.unpricedCount }] as const)
			.sort((a, b) => (b[1].promptTokens + b[1].completionTokens) - (a[1].promptTokens + a[1].completionTokens));

		const allVendors = vendorEntries.map(([v]) => v);

		const dailyAvgCost = combineToCny(s.allTime.totalCostUsd, s.allTime.totalCostCny) / Math.max(1, s.allTime.daysTracked);

		// Requests with no known pricing (cost shown as N/A rather than a made-up number)
		const totalRequestsAll = s.vendorBreakdown.reduce((sum, v) => sum + v.requestCount, 0);
		const totalUnpriced = s.vendorBreakdown.reduce((sum, v) => sum + v.unpricedCount, 0);
		const allUnpriced = totalRequestsAll > 0 && totalUnpriced >= totalRequestsAll;

		// Estimated environmental impact (heuristic from token counts; never provider-reported)
		let totalEnergyWh = 0;
		for (const m of s.modelBreakdown) {
			totalEnergyWh += estimateEnergy(m.promptTokens, m.completionTokens, m.modelId).totalWh;
		}
		const energyLabel = formatEnergy(totalEnergyWh);
		const co2Label = formatCO2(estimateCO2Grams(totalEnergyWh));

		// True per-vendor daily costs: SUM(estimated_cost_usd) grouped by (date, vendor)
		const vendorDayTotals = await this._tracker.metricsService.getDayTotalsByVendor(this._days);
		const costByVendorPerDate = new Map<string, Map<string, number>>();
		for (const row of vendorDayTotals) {
			let m = costByVendorPerDate.get(row.vendor);
			if (!m) { m = new Map(); costByVendorPerDate.set(row.vendor, m); }
			m.set(row.date, (m.get(row.date) ?? 0) + combineToCny(row.estimatedCostUsd, row.estimatedCostCny));
		}

		// Range data for charts
		const month = [...s.thisMonth];

		// Diagnostic: log chart data shape
		const monthNonZero = month.filter(d => d.totalPromptTokens + d.totalCompletionTokens > 0);
		console.log(`[TokenUsageDashboard] render: month.length=${month.length} nonZero=${monthNonZero.length} vendors=${vendorEntries.length}`);

		// Generate full date range for the selected period (local-time keys)
		const rangeDates: string[] = [];
		for (let i = this._days - 1; i >= 0; i--) {
			const d = new Date();
			d.setDate(d.getDate() - i);
			rangeDates.push(localDateKey(d));
		}
		// Build lookup map from DB data
		const monthMap = new Map<string, typeof month[0]>();
		for (const d of month) { monthMap.set(d.date, d); }

		const today = s.today;
		const totalToday = today.totalPromptTokens + today.totalCompletionTokens;
		const allTime = s.allTime;

		const chartData = JSON.stringify({
			allDates: rangeDates,
			firstTrackedDate: allTime.firstTrackedDate,
			allVendors,
			labels: rangeDates.map(d => d.slice(5)),
			monthLabels: rangeDates.map(d => d.slice(5)),
			monthTokens: rangeDates.map(d => monthMap.get(d)?.totalPromptTokens! + monthMap.get(d)?.totalCompletionTokens! || 0),
			monthPrompt: rangeDates.map(d => monthMap.get(d)?.totalPromptTokens ?? 0),
			monthCompletion: rangeDates.map(d => monthMap.get(d)?.totalCompletionTokens ?? 0),
			monthCosts: rangeDates.map(d => combineToCny(monthMap.get(d)?.estimatedCostUsd ?? 0, monthMap.get(d)?.estimatedCostCny ?? 0)),
			vendorNames: vendorEntries.map(([v]) => v),
			vendorTokens: vendorEntries.map(([, a]) => a.promptTokens + a.completionTokens),
			vendorColors: vendorEntries.map(([v]) => vendorColor(v)),
			// Vendor+Model combo bar chart
			vmLabels: s.modelBreakdown.map(m => m.modelId),
			vmTokens: s.modelBreakdown.map(m => m.promptTokens + m.completionTokens),
			vmColors: s.modelBreakdown.map(m => vendorColor(vendorForModel(m.modelId))),
			vmVendors: s.modelBreakdown.map(m => vendorForModel(m.modelId)),
			// True per-vendor daily costs: SUM(estimated_cost_usd) per (date, vendor)
			vendorStackLabels: rangeDates.map(d => d.slice(5)),
			vendorStackVendors: vendorEntries.map(([v]) => v),
			vendorStackColors: vendorEntries.map(([v]) => vendorColor(v)),
			vendorStackCosts: vendorEntries.map(([v]) => rangeDates.map(d => costByVendorPerDate.get(v)?.get(d) ?? 0)),
		});

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${webviewCsp(nonce)}">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Token 用量总览</title>
<style>
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

/* Cards */
.grid5{display:grid;grid-template-columns:repeat(5,1fr);gap:10px;margin-bottom:20px}
@media(max-width:1100px){.grid5{grid-template-columns:repeat(3,1fr)}}
@media(max-width:640px){.grid5{grid-template-columns:repeat(2,1fr)}}
.card{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px 16px}
.card .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);margin-bottom:4px}
.card .val{font-size:22px;font-weight:700}
.card .det{font-size:10px;color:var(--muted);margin-top:2px}

/* Section */
.sec{background:var(--card);border:1px solid var(--border);border-radius:8px;padding:18px;margin-bottom:14px}
.sec-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}
.sec-t{font-size:14px;font-weight:600}

/* Toggle (responsive segmented control) */
.tgl{display:flex;gap:2px;background:var(--bg);border-radius:5px;padding:2px;border:1px solid var(--border);white-space:nowrap}
.tgl button{padding:3px 10px;font-size:10px;font-weight:500;border:none;border-radius:3px;cursor:pointer;background:transparent;color:var(--muted);font-family:var(--font);white-space:nowrap;flex:0 0 auto}
.tgl button.on{background:var(--accent);color:#fff}
.tgl button:focus-visible{outline:1px solid var(--vscode-focusBorder,#007fd4);outline-offset:1px}

/* Charts */
.ch2{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
@media(max-width:700px){.ch2{grid-template-columns:1fr}}
.ch{position:relative;height:180px}
.ch canvas{width:100%!important;height:100%!important}

/* Vendor filter */
.flt{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}
.flt label{display:flex;align-items:center;gap:4px;font-size:11px;cursor:pointer;padding:3px 8px;border-radius:4px;border:1px solid var(--border);background:var(--bg)}
.flt label.chk{background:var(--accent);color:#fff;border-color:var(--accent)}
.flt input{display:none}

/* Table */
.tbl{width:100%;border-collapse:collapse}
.tbl th{font-size:9px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted);padding:8px 10px;text-align:left;border-bottom:1px solid var(--border)}
.tbl td{font-size:11px;padding:8px 10px;border-bottom:1px solid var(--border)}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle}

/* Date Range Picker */
.hdr{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap;margin-bottom:20px}
.drp{display:flex;align-items:center;gap:6px;flex:0 0 auto;min-width:max-content}
@media(max-width:760px){.hdr .drp{width:100%}}
.drp-date{padding:3px 8px;font-size:10px;border:1px solid var(--border);border-radius:3px;background:var(--bg);color:var(--text);font-family:var(--font);display:none}
.drp-date:focus{border-color:var(--accent);outline:none}

/* Pricing-rule popover (ⓘ 计价规则) */
.pinfo{position:relative;display:inline-block;cursor:pointer;color:var(--accent);outline:none}
.pinfo:focus-visible{outline:1px solid var(--vscode-focusBorder,#007fd4);border-radius:3px}
.pinfo-pop{display:none;position:absolute;left:0;top:130%;z-index:10;min-width:280px;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:6px;padding:8px 12px;box-shadow:0 4px 14px rgba(0,0,0,.35);font-size:11px;line-height:1.7;color:var(--text);text-align:left}
.pinfo:hover .pinfo-pop,.pinfo:focus .pinfo-pop,.pinfo:focus-within .pinfo-pop,.pinfo.open .pinfo-pop{display:block}
.pinfo-item{display:block;white-space:normal}
.pinfo-item::before{content:'•';color:var(--muted);margin-right:6px}
</style>
</head>
<body>

<div class="hdr">
  <div>
    <h1>Token 用量总览</h1>
    <p class="subtitle">各厂商聊天模型 Token 消耗与等效 API 成本 · 按中国大陆官方按量 API 单价估算。<span class="pinfo" tabindex="0" role="note" aria-label="计价规则说明">ⓘ 计价规则<span class="pinfo-pop" role="tooltip"><span class="pinfo-item">不考虑套餐 / TokenPlan / 免费额度 / 优惠或第三方渠道价格</span><span class="pinfo-item">DeepSeek 按北京时间峰谷规则逐轮计价（周末与法定节假日全天按闲时）</span><span class="pinfo-item">缓存信息缺失时按官方缓存未命中价格估算</span><span class="pinfo-item">VS Code Utility Model 后台调用可能不进入统计</span></span></span> · 最早数据：<strong>${allTime.firstTrackedDate ?? '—'}</strong> · <a href="#" onclick="_vscode.postMessage({type:'reload'});return false" style="color:var(--accent);text-decoration:none" title="从本地会话文件重新构建统计数据">↻ 重新构建统计数据</a></p>
  </div>
  <div class="drp">
    <div class="tgl" id="tglRange">
      <button data-r="week" title="最近 7 天" aria-pressed="${this._rangeMode === 'week'}" ${this._rangeMode === 'week' ? 'class="on"' : ''}>7 天</button>
      <button data-r="month" title="最近 30 天" aria-pressed="${this._rangeMode === 'month'}" ${this._rangeMode === 'month' ? 'class="on"' : ''}>30 天</button>
      <button data-r="since" title="自选开始日期（含当天）" aria-pressed="${this._rangeMode === 'since'}" ${this._rangeMode === 'since' ? 'class="on"' : ''}>自选</button>
    </div>
    <input type="date" id="sinceDate" class="drp-date" value="${this._sinceDate}" style="${this._rangeMode === 'since' ? 'display:inline-block' : ''}" />
  </div>
</div>

<div class="grid5">
  <div class="card"><div class="lbl">今日 Token</div><div class="val">${formatTokenCount(totalToday)}</div><div class="det">输入 ${formatTokenCount(today.totalPromptTokens)} / 输出 ${formatTokenCount(today.totalCompletionTokens)}</div></div>
  <div class="card"><div class="lbl">今日等效 API 成本</div><div class="val">${formatCnyUi(combineToCny(today.estimatedCostUsd, today.estimatedCostCny))}</div><div class="det">${vendorEntries.length} 家厂商有活动</div></div>
  <div class="card"><div class="lbl">Token 用量</div><div class="val">${formatTokenCount(allTime.totalPromptTokens + allTime.totalCompletionTokens)}</div><div class="det">自 ${allTime.firstTrackedDate} 起</div></div>
  <div class="card"><div class="lbl">等效 API 成本</div><div class="val">${allUnpriced ? '暂无价格' : formatCnyUi(combineToCny(allTime.totalCostUsd, allTime.totalCostCny))}</div><div class="det">${allUnpriced ? '这些模型暂无价格数据' : `日均 ${formatCnyCompact(dailyAvgCost)}`}</div></div>
  <div class="card"><div class="lbl">活跃厂商</div><div class="val">${vendorEntries.length}</div><div class="det">${allTime.daysTracked} 天的数据</div></div>
</div>

<!-- Charts -->
<div class="sec">
  <div class="sec-h">
    <div class="sec-t">用量趋势</div>
  </div>
  <div class="ch2">
    <div><div style="font-size:11px;color:var(--muted);margin-bottom:6px;font-weight:500">Token（输入 / 输出）</div><div class="ch"><canvas id="tokenChart"></canvas></div></div>
    <div><div style="font-size:11px;color:var(--muted);margin-bottom:6px;font-weight:500">等效 API 成本（¥）</div><div class="ch"><canvas id="costChart"></canvas></div></div>
  </div>
</div>

<!-- Vendor Filter -->
<div class="sec">
  <div class="sec-h"><div class="sec-t">厂商用量分布</div><span style="font-size:10px;color:var(--muted)">按厂商筛选</span></div>
  <div class="flt" id="fltVendors">
    ${allVendors.map((v, i) => `<label class="chk" data-v="${v}">
      <input type="checkbox" checked><span class="dot" style="background:${vendorColor(v)}"></span>${formatVendorName(v)}
    </label>`).join('')}
  </div>
  <div class="ch2">
    <div><div class="ch"><canvas id="vendorDonut"></canvas></div></div>
    <div style="overflow-y:auto;max-height:200px">
      <table class="tbl" id="vendorTbl"><thead><tr><th>厂商</th><th>Token</th><th>等效 API 成本</th></tr></thead><tbody>
        ${vendorEntries.map(([v, a]) => `<tr data-v="${v}">
          <td><span class="dot" style="background:${vendorColor(v)}"></span>${formatVendorName(v)}</td>
          <td>${formatTokenCount(a.promptTokens + a.completionTokens)}</td>
          <td>${a.unpricedCount >= a.requestCount ? '暂无价格' : formatCnyUi(a.cost)}</td>
        </tr>`).join('')}
      </tbody></table>
    </div>
  </div>
</div>

<!-- Per-Vendor Daily Chart -->
<div class="sec">
  <div class="sec-h"><div class="sec-t">各厂商每日等效 API 成本</div></div>
  <div style="height:200px"><canvas id="vendorStackChart"></canvas></div>
</div>

<!-- Vendor+Model Combo -->
<div class="sec">
  <div class="sec-h">
    <div class="sec-t">厂商 / 模型用量</div>
    <span style="font-size:10px;color:var(--muted)">各模型 Token 用量，按厂商着色</span>
  </div>
  <div style="height:220px"><canvas id="vmChart"></canvas></div>
</div>

<!-- Estimated Environmental Impact (heuristic; not provider-reported) -->
<div class="sec">
  <div class="sec-h">
    <div class="sec-t">AI 环境影响估算</div>
    <span style="font-size:10px;color:var(--muted)">根据 Token 用量启发式估算 — 非厂商实际报告数据</span>
  </div>
  <div class="ch2">
    <div class="card"><div class="lbl">AI 能耗估算</div><div class="val" style="font-size:18px">${energyLabel}</div><div class="det">所选区间的预估能耗</div></div>
    <div class="card"><div class="lbl">CO₂ 排放估算</div><div class="val" style="font-size:18px">${co2Label}</div><div class="det">估算值 · 电网强度 0.39 kg/kWh</div></div>
  </div>
</div>

<script nonce="${nonce}">${chartJsSource()}</script>
<script nonce="${nonce}">${AMOUNT_FMT_JS}
const D = ${chartData};
console.log('[Dashboard] Data loaded:',{monthLabels:D.monthLabels.length,vendorNames:D.vendorNames.length});
const VNAME={'mimo':'MiMo','xiaomi':'MiMo','deepseek':'DeepSeek','glm':'GLM','qwen':'Qwen','copilot':'GitHub Copilot','unknown':'未知'};
const vName=v=>VNAME[String(v).toLowerCase()]||v;
var _vscode = acquireVsCodeApi();

function _postDateChange(days, mode, sinceDate) {
  _vscode.postMessage({ type: 'dateChange', days: days, mode: mode || 'month', sinceDate: sinceDate || '' });
}
setTimeout(function(){
requestAnimationFrame(function(){
try{
Chart.defaults.color = getComputedStyle(document.body).getPropertyValue('--muted').trim()||'#888';
Chart.defaults.borderColor = getComputedStyle(document.body).getPropertyValue('--border').trim()||'#404';
Chart.defaults.font.size = 10;

// ── Token Chart ──
const tCtx = document.getElementById('tokenChart').getContext('2d');
const tokenChart = new Chart(tCtx,{type:'bar',data:{labels:D.monthLabels,datasets:[
  {label:'输入',data:D.monthPrompt,backgroundColor:'rgba(59,130,246,.7)',borderRadius:3},
  {label:'输出',data:D.monthCompletion,backgroundColor:'rgba(249,115,22,.7)',borderRadius:3}
]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{boxWidth:8,padding:10}}},
scales:{x:{stacked:true,grid:{display:false}},y:{stacked:true,ticks:{callback:v=>v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(0)+'K':v}}}}});

// ── Cost Chart ──
const cCtx = document.getElementById('costChart').getContext('2d');
const costChart = new Chart(cCtx,{type:'line',data:{labels:D.monthLabels,datasets:[
  {label:'等效 API 成本',data:D.monthCosts,borderColor:'rgba(16,185,129,.9)',backgroundColor:'rgba(16,185,129,.1)',fill:true,tension:.3,pointRadius:3,borderWidth:2}
]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>'等效 API 成本: '+fmtCnyTiny(ctx.raw)}}},
scales:{x:{grid:{display:false}},y:{ticks:{callback:v=>fmtCnyAxis(v)}}}}});

// ── Vendor Donut ──
const vCtx = document.getElementById('vendorDonut').getContext('2d');
const vendorDonut = new Chart(vCtx,{type:'doughnut',data:{labels:D.vendorNames.map(vName),datasets:[
  {data:D.vendorTokens,backgroundColor:D.vendorColors,borderWidth:0,hoverOffset:4}
]},options:{responsive:true,maintainAspectRatio:false,cutout:'55%',plugins:{legend:{display:false}}}});

// ── Vendor Stack Chart (true daily SUM of estimated cost per vendor) ──
const vsCtx = document.getElementById('vendorStackChart').getContext('2d');
const vendorStackChart = new Chart(vsCtx,{type:'bar',data:{labels:D.vendorStackLabels,datasets:D.vendorStackVendors.map((v,i)=>({
  label:vName(v),data:D.vendorStackCosts[i],
  backgroundColor:D.vendorStackColors[i]+'cc',borderRadius:2
}))},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'top',labels:{boxWidth:8,padding:8}},tooltip:{callbacks:{label:ctx=>ctx.dataset.label+': '+fmtCnyTiny(ctx.raw)}}},
scales:{x:{stacked:true,grid:{display:false}},y:{stacked:true,ticks:{callback:v=>fmtCnyAxis(v)}}}}});

// ── Vendor+Model Combo Chart ──
const vmCtx = document.getElementById('vmChart').getContext('2d');
const vmChart = new Chart(vmCtx,{type:'bar',data:{labels:D.vmLabels,datasets:[
  {label:'Token 用量',data:D.vmTokens,backgroundColor:D.vmColors.map(c=>c+'99'),borderColor:D.vmColors,borderWidth:1,borderRadius:3}
]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},
tooltip:{callbacks:{label:ctx=>{
  const v = D.vmVendors[ctx.dataIndex];
  return v +': '+ ctx.dataset.label + ': ' + (ctx.raw>=1e6?(ctx.raw/1e6).toFixed(1)+'M':ctx.raw>=1e3?(ctx.raw/1e3).toFixed(0)+'K':ctx.raw);
}}}},
scales:{x:{grid:{display:false},ticks:{maxRotation:45,minRotation:45,font:{size:8}}},
y:{ticks:{callback:v=>v>=1e6?(v/1e6).toFixed(1)+'M':v>=1e3?(v/1e3).toFixed(0)+'K':v}}}}});


// ── Vendor filter ──
document.getElementById('fltVendors').addEventListener('click',e=>{
  const lbl = e.target.closest('label');
  if(!lbl) return;
  lbl.classList.toggle('chk');
  const cb = lbl.querySelector('input');
  cb.checked = !cb.checked;
  _refreshVendorFilter();
});

function _getActiveVendors(){
  const active = [];
  document.querySelectorAll('#fltVendors label').forEach(l=>{
    if(l.querySelector('input').checked) active.push(l.dataset.v);
  });
  return active;
}

function _refreshVendorFilter(){
  const active = _getActiveVendors();
  // Show/hide table rows
  document.querySelectorAll('#vendorTbl tbody tr').forEach(tr=>{
    tr.style.display = active.includes(tr.dataset.v) ? '' : 'none';
  });
  // Update donut chart
  const idxs = [];
  const names = [];
  const tokens = [];
  const colors = [];
  D.vendorNames.forEach((v,i)=>{
    if(active.includes(v)){
      idxs.push(i);
      names.push(vName(v));
      tokens.push(D.vendorTokens[i]);
      colors.push(D.vendorColors[i]);
    }
  });
  vendorDonut.data.labels = names;
  vendorDonut.data.datasets[0].data = tokens;
  vendorDonut.data.datasets[0].backgroundColor = colors;
  vendorDonut.update();
}
}catch(e){console.error('[Dashboard] Chart init error:',e);document.body.insertAdjacentHTML('beforeend','<div style="color:red;padding:10px">Chart error: '+e.message+'</div>');}

// ── Date Range Picker (always registered) ──
const _dateInput = document.getElementById('sinceDate');
document.getElementById('tglRange').addEventListener('click', e => {
  const btn = e.target.closest('button');
  if(!btn) return;
  document.querySelectorAll('#tglRange button').forEach(b => { b.classList.remove('on'); b.setAttribute('aria-pressed','false'); });
  btn.classList.add('on');
  btn.setAttribute('aria-pressed','true');
  const r = btn.dataset.r;
  if(r === 'week') {
    _dateInput.style.display = 'none';
    _postDateChange(7, 'week', '');
  } else if(r === 'month') {
    _dateInput.style.display = 'none';
    _postDateChange(30, 'month', '');
  } else if(r === 'since') {
    _dateInput.style.display = 'inline-block';
    _dateInput.focus();
    if(_dateInput.value) {
      const sinceMs = new Date(_dateInput.value).getTime();
      const days = Math.max(1, Math.ceil((Date.now() - sinceMs) / 86400000) + 1);
      _postDateChange(days, 'since', _dateInput.value);
    }
  }
});
_dateInput.addEventListener('change', function() {
  if(this.value) {
    const sinceMs = new Date(this.value).getTime();
    const days = Math.max(1, Math.ceil((Date.now() - sinceMs) / 86400000) + 1);
    _postDateChange(days, 'since', this.value);
  }
});

// ── Pricing-rule popover (click toggle for touch; Esc closes) ──
var _pinfo = document.querySelector('.pinfo');
if (_pinfo) {
  _pinfo.addEventListener('click', function () { _pinfo.classList.toggle('open'); });
  _pinfo.addEventListener('keydown', function (e) { if (e.key === 'Escape') { _pinfo.classList.remove('open'); } });
}
});
});
</script>
</body>
</html>`;
	}

	private dispose(): void {
		TokenUsageDashboard.currentPanel = undefined;
		this._panel.dispose();
		for (const d of this._disposables) { d.dispose(); }
	}
}
