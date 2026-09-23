/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { resolveDeepseekPricing } from './dynamicPricing';

/**
 * Per-model token pricing in the rule's native currency (CNY or USD) per 1M tokens.
 * Loaded from pricing.json at startup. Fields are optional; absent means
 * that price component is not applicable or unknown for this model.
 */
export interface ModelPricing {
	readonly currency: 'CNY' | 'USD';
	readonly inputPerMillion: number;
	readonly outputPerMillion: number;
	readonly cacheReadPerMillion?: number;
	readonly cacheWritePerMillion?: number;
	/** 价格生效时间（UTC 毫秒，北京时间当日 0 点）。早于该时间的请求不得套用此价格。 */
	readonly effectiveFromMs?: number;
	readonly inputLongPerMillion?: number;
	readonly outputLongPerMillion?: number;
	readonly cacheReadLongPerMillion?: number;
}

/**
 * Per-model energy consumption in Watt-hours per token.
 */
export interface ModelEnergy {
	readonly inputWhPerToken: number;
	readonly outputWhPerToken: number;
}

export interface TurnCostEstimate {
	/** 价格规则的原生币种：CNY（官方人民币原价）或 USD（官方美元价，展示时按汇率折算）。 */
	readonly currency: 'CNY' | 'USD';
	readonly inputCost: number;
	readonly outputCost: number;
	readonly cacheReadCost?: number;
	/** 原生币种下的总费用。 */
	readonly total: number;
	/** 计价规则说明（DeepSeek 动态规则时包含版本与峰谷信息）。 */
	readonly pricingNote?: string;
}

export interface EnergyEstimate {
	readonly inputWh: number;
	readonly outputWh: number;
	readonly totalWh: number;
}

// ─── Raw row from pricing.json ────────────────────────────────────────────────

interface PricingRow {
	id: string;
	name: string;
	provider: string;
	/** 价格原生币种，缺省 USD。 */
	currency?: 'CNY' | 'USD';
	/** 可选生效日期（YYYY-MM-DD，北京时间当日 0 点生效）。早于该日期的请求按 N/A 处理。 */
	effectiveFrom?: string;
	pricing: {
		input: number;
		output: number;
		cacheHit?: number;
		cacheWrite?: number;
		inputLongContext?: number;
		outputLongContext?: number;
		cacheHitLongContext?: number;
	};
	copilotPricing?: {
		input: number;
		output: number;
		cacheHit?: number;
		cacheWrite?: number;
	};
}

interface PricingFile {
	models: PricingRow[];
}

// ─── Dynamically-loaded pricing table ─────────────────────────────────────────

let _pricingLoaded = false;
const _pricingMap: Record<string, ModelPricing> = {};
const _idByAlias: Record<string, string> = {};

/**
 * Resolve the path to pricing.json relative to the compiled output directory.
 * __dirname = out/tokenUsage/ → ../../data/pricing.json
 * 回退：__dirname 不可用时（如 vitest/ESM 环境）从进程工作目录解析。
 */
function _pricingJsonPath(): string {
	if (typeof __dirname !== 'undefined') {
		return path.resolve(__dirname, '..', '..', 'data', 'pricing.json');
	}
	return path.resolve(process.cwd(), 'data', 'pricing.json');
}

/**
 * Load pricing data from pricing.json into the lookup maps.
 * Safe to call multiple times — the cache flag prevents redundant I/O.
 */
function _ensurePricingLoaded(): void {
	if (_pricingLoaded) { return; }

	try {
		const filePath = _pricingJsonPath();
		const raw = fs.readFileSync(filePath, 'utf8');
		const data: PricingFile = JSON.parse(raw);

		for (const model of data.models) {
			const p = model.pricing;
			const cp = model.copilotPricing;

			// Prefer copilotPricing when available (GitHub Copilot-specific rate)
			const src = cp ?? p;

			const m: ModelPricing = {
				currency: model.currency ?? 'USD',
				inputPerMillion: src.input,
				outputPerMillion: src.output,
				...(src.cacheHit !== undefined && { cacheReadPerMillion: src.cacheHit }),
				...(src.cacheWrite !== undefined && { cacheWritePerMillion: src.cacheWrite }),
				...(p.inputLongContext !== undefined && { inputLongPerMillion: p.inputLongContext }),
				...(p.outputLongContext !== undefined && { outputLongPerMillion: p.outputLongContext }),
				...(p.cacheHitLongContext !== undefined && { cacheReadLongPerMillion: p.cacheHitLongContext }),
			};
			// "2026-09-22" → 北京时间当日 00:00 的 UTC 毫秒。
			if (model.effectiveFrom) {
				const ms = Date.parse(`${model.effectiveFrom}T00:00:00+08:00`);
				if (!Number.isNaN(ms)) {
					(m as { effectiveFromMs?: number }).effectiveFromMs = ms;
				}
			}

			_pricingMap[model.id] = m;

			// Build alias map for fuzzy matching: lowercase id without special chars
			const alias = model.id.toLowerCase().replace(/[-_.\s]/g, '');
			_idByAlias[alias] = model.id;
		}

		_pricingLoaded = true;
		console.log(`[TokenCostEstimator] loaded ${Object.keys(_pricingMap).length} models from pricing.json`);
	} catch (err) {
		console.error('[TokenCostEstimator] failed to load pricing.json, using fallback:', err);
	}
}

const MODEL_ENERGY: Record<string, ModelEnergy> = {
	'gpt-5.4': { inputWhPerToken: 0.00038, outputWhPerToken: 0.0038 },
	'gpt-5.4-mini': { inputWhPerToken: 0.000040, outputWhPerToken: 0.00040 },
	'gpt-5.4-nano': { inputWhPerToken: 0.000040, outputWhPerToken: 0.00040 },
	'gpt-5-mini': { inputWhPerToken: 0.000030, outputWhPerToken: 0.00030 },
	'gpt-5.5': { inputWhPerToken: 0.00050, outputWhPerToken: 0.0050 },
	'gpt-5.6-sol': { inputWhPerToken: 0.00060, outputWhPerToken: 0.0060 },
	'gpt-5.6-terra': { inputWhPerToken: 0.00045, outputWhPerToken: 0.0045 },
	'gpt-5.6-luna': { inputWhPerToken: 0.00035, outputWhPerToken: 0.0035 },
	'gpt-5.3-codex': { inputWhPerToken: 0.00040, outputWhPerToken: 0.0040 },
	'claude-haiku-4-5': { inputWhPerToken: 0.00015, outputWhPerToken: 0.0015 },
	'claude-sonnet-4':  { inputWhPerToken: 0.00038,  outputWhPerToken: 0.0038 },
	'claude-sonnet-4-5': { inputWhPerToken: 0.00038, outputWhPerToken: 0.0038 },
	'claude-sonnet-4-6': { inputWhPerToken: 0.00038, outputWhPerToken: 0.0038 },
	'claude-sonnet-5': { inputWhPerToken: 0.00032, outputWhPerToken: 0.0032 },
	'claude-opus-4-5': { inputWhPerToken: 0.00080, outputWhPerToken: 0.0080 },
	'claude-opus-4-6': { inputWhPerToken: 0.00080, outputWhPerToken: 0.0080 },
	'claude-opus-4-7': { inputWhPerToken: 0.00080, outputWhPerToken: 0.0080 },
	'claude-opus-4-8': { inputWhPerToken: 0.00080, outputWhPerToken: 0.0080 },
	'claude-fable-5': { inputWhPerToken: 0.00100, outputWhPerToken: 0.0100 },
	'gemini-2.5-pro': { inputWhPerToken: 0.00050, outputWhPerToken: 0.0050 },
	'gemini-2.5-flash': { inputWhPerToken: 0.00015, outputWhPerToken: 0.0015 },
	'gemini-2.5-flash-lite': { inputWhPerToken: 0.000060, outputWhPerToken: 0.00060 },
	'gemini-3-flash': { inputWhPerToken: 0.00015, outputWhPerToken: 0.0015 },
	'gemini-3.1-pro-preview': { inputWhPerToken: 0.00055, outputWhPerToken: 0.0055 },
	'gemini-3.5-flash': { inputWhPerToken: 0.00012, outputWhPerToken: 0.0012 },
	'deepseek-v4-flash': { inputWhPerToken: 0.000080, outputWhPerToken: 0.00080 },
	'deepseek-v4-pro': { inputWhPerToken: 0.00020, outputWhPerToken: 0.0020 },
	'grok-4.5': { inputWhPerToken: 0.00060, outputWhPerToken: 0.0060 },
	'glm-5': { inputWhPerToken: 0.00035, outputWhPerToken: 0.0035 },
	'glm-5.1': { inputWhPerToken: 0.00035, outputWhPerToken: 0.0035 },
	'glm-5.2': { inputWhPerToken: 0.00035, outputWhPerToken: 0.0035 },
	'glm-5-turbo': { inputWhPerToken: 0.00035, outputWhPerToken: 0.0035 },
	'glm-4.7': { inputWhPerToken: 0.00030, outputWhPerToken: 0.0030 },
	'kimi-k3': { inputWhPerToken: 0.00055, outputWhPerToken: 0.0055 },
	'kimi-k2.7-code': { inputWhPerToken: 0.00035, outputWhPerToken: 0.0035 },
	'kimi-k2.6': { inputWhPerToken: 0.00035, outputWhPerToken: 0.0035 },
	'qwen3.7-max': { inputWhPerToken: 0.00050, outputWhPerToken: 0.0050 },
	'qwen3.7-plus': { inputWhPerToken: 0.00030, outputWhPerToken: 0.0030 },
	'qwen3.6-plus': { inputWhPerToken: 0.00030, outputWhPerToken: 0.0030 },
	'minimax-m3': { inputWhPerToken: 0.00030, outputWhPerToken: 0.0030 },
	'minimax-m2.7': { inputWhPerToken: 0.00030, outputWhPerToken: 0.0030 },
	'mimo-v2.5': { inputWhPerToken: 0.000080, outputWhPerToken: 0.00080 },
	'mimo-v2.5-pro': { inputWhPerToken: 0.00020, outputWhPerToken: 0.0020 },
	'ernie-5.1': { inputWhPerToken: 0.00040, outputWhPerToken: 0.0040 },
	'raptor-mini': { inputWhPerToken: 0.000040, outputWhPerToken: 0.00040 },
	'mai-code-1-flash': { inputWhPerToken: 0.000040, outputWhPerToken: 0.00040 },
};

const DEFAULT_ENERGY: ModelEnergy = { inputWhPerToken: 0.00038, outputWhPerToken: 0.0038 };
export const GRID_CARBON_INTENSITY_KG_PER_KWH = 0.39;

// ─── Model name resolution ───────────────────────────────────────────────────

/**
 * Resolve a model name to a pricing key (model id in pricing.json).
 * First checks exact match, then falls back to fuzzy alias matching.
 * Returns null when no pricing entry matches — callers must NOT substitute
 * an unrelated model's price; cost simply becomes unavailable for that model.
 */
export function resolveModelPricingKey(modelName: string): string | null {
	_ensurePricingLoaded();

	// Exact match (most common case)
	if (_pricingMap[modelName]) { return modelName; }

	// Fuzzy match via aliases
	const normalized = modelName.toLowerCase().replace(/[-_.\s]/g, '');
	if (_idByAlias[normalized]) { return _idByAlias[normalized]; }

	// Provider/vendor prefixes — strip them and try again
	const stripped = modelName.includes('/') ? modelName.split('/').pop()! : modelName;
	const strippedAlias = stripped.toLowerCase().replace(/[-_.\s]/g, '');
	if (_idByAlias[strippedAlias]) { return _idByAlias[strippedAlias]; }

	// No pricing entry — do not guess.
	return null;
}

// ─── Cost / Energy estimation ────────────────────────────────────────────────

interface CostComponents {
	inputCost: number;
	outputCost: number;
	cacheReadCost?: number;
	total: number;
}

function _computeCost(
	promptTokens: number,
	completionTokens: number,
	cachedTokens: number,
	pricing: Pick<ModelPricing, 'inputPerMillion' | 'outputPerMillion' | 'cacheReadPerMillion'>,
): CostComponents {
	const inputCost = (promptTokens / 1_000_000) * pricing.inputPerMillion;
	const outputCost = (completionTokens / 1_000_000) * pricing.outputPerMillion;
	let cacheReadCost: number | undefined;
	if (cachedTokens > 0 && pricing.cacheReadPerMillion !== undefined) {
		cacheReadCost = (cachedTokens / 1_000_000) * pricing.cacheReadPerMillion;
	}
	return { inputCost, outputCost, cacheReadCost, total: inputCost + outputCost + (cacheReadCost ?? 0) };
}

/**
 * 逐 Turn 估算“官方 API 原价”（按价格规则的原生币种）：
 *  - DeepSeek：按请求时间（UTC 毫秒）应用峰谷规则、法定节假日、历史生效价格与 alias 路由；
 *  - 其他模型：使用 pricing.json 中的官方价格（中国区官方价优先，人民币直接计算）。
 *
 * 返回 null 表示该模型无可确认的官方价格 —— UI 必须显示 N/A，绝不套用相近模型的单价。
 *
 * 缓存说明：VS Code 会话记录未提供可靠的缓存命中 Token 时，输入 Token 全部按
 * 官方“缓存未命中”价格估算（调用方传入 cachedTokens = 0）。
 */
export function estimateTurnCost(
	promptTokens: number,
	completionTokens: number,
	cachedTokens: number,
	modelName: string,
	timestampMs?: number,
): TurnCostEstimate | null {
	const ts = (typeof timestampMs === 'number' && timestampMs > 0) ? timestampMs : Date.now();

	// 1) DeepSeek 动态规则（峰谷 / 节假日 / alias / 历史生效日期）
	const ds = resolveDeepseekPricing(modelName, ts);
	if (ds) {
		const c = _computeCost(promptTokens, completionTokens, cachedTokens, {
			inputPerMillion: ds.rates.cacheMiss,
			outputPerMillion: ds.rates.output,
			cacheReadPerMillion: ds.rates.cacheHit,
		});
		return { currency: 'CNY', ...c, pricingNote: ds.note };
	}

	// 2) 静态价格表
	_ensurePricingLoaded();
	const key = resolveModelPricingKey(modelName);
	if (!key) { return null; }
	const pricing = _pricingMap[key];
	if (!pricing) { return null; }
	// 生效日期门控：模型/价格在该时间点尚不存在时，历史 Turn 不得用未来价格倒算。
	if (pricing.effectiveFromMs !== undefined && ts < pricing.effectiveFromMs) { return null; }

	const c = _computeCost(promptTokens, completionTokens, cachedTokens, pricing);
	return { currency: pricing.currency, ...c, pricingNote: key };
}

export function estimateEnergy(
	promptTokens: number,
	completionTokens: number,
	modelName: string = '',
): EnergyEstimate {
	// Dynamic-rule models (e.g. DeepSeek) are no longer in the static table —
	// fall back to the canonical (last-path-segment, lowercase) id for energy lookup.
	const key = resolveModelPricingKey(modelName)
		?? (modelName.toLowerCase().split('/').pop() ?? '');
	const energyKey = key === 'deepseek-flash' || key === 'deepseek-v4-flash-vision-exp'
		? 'deepseek-v4-flash' : key;
	const energy = (energyKey ? MODEL_ENERGY[energyKey] : undefined) || DEFAULT_ENERGY;
	return {
		inputWh: promptTokens * energy.inputWhPerToken,
		outputWh: completionTokens * energy.outputWhPerToken,
		totalWh: (promptTokens * energy.inputWhPerToken) + (completionTokens * energy.outputWhPerToken),
	};
}

export function estimateCO2Grams(wattHours: number): number {
	return (wattHours / 1000) * GRID_CARBON_INTENSITY_KG_PER_KWH * 1000;
}

// ─── Date helpers ────────────────────────────────────────────────────────────

/**
 * Format a Date as a local-time `YYYY-MM-DD` key. Aligns with SQLite's
 * `date(..., 'localtime')` grouping so daily charts match the stored data.
 */
export function localDateKey(d: Date = new Date()): string {
	const y = d.getFullYear();
	const m = String(d.getMonth() + 1).padStart(2, '0');
	const day = String(d.getDate()).padStart(2, '0');
	return `${y}-${m}-${day}`;
}

// ─── Currency (USD → CNY display) ────────────────────────────────────────────

/**
 * USD → CNY display rate. The bundled pricing.json keeps official USD prices;
 * this rate is applied only when formatting amounts for the UI. Configurable
 * via `modelMeter.tokenUsage.usdToCnyRate` (no network lookup).
 */
let _usdToCnyRate = 7.2;

export function setUsdToCnyRate(rate: number): void {
	if (typeof rate === 'number' && Number.isFinite(rate) && rate > 0) {
		_usdToCnyRate = rate;
	}
}

export function getUsdToCnyRate(): number { return _usdToCnyRate; }

/** Convert a USD amount to CNY using the configured display rate. */
export function toCny(usd: number): number { return usd * _usdToCnyRate; }

/**
 * 将“原生双币种”费用合并为展示用人民币金额（USD 列 × 当前汇率 + CNY 列直接相加）。
 * 这是唯一的汇率应用点：人民币定价的模型完全不经过汇率，美元定价的模型仅在此折算一次，
 * 不会出现 CNY → USD → CNY 的往返换算。
 */
export function combineToCny(usd?: number | null, cny?: number | null): number {
	return (usd ?? 0) * _usdToCnyRate + (cny ?? 0);
}

// ─── Display formatting ──────────────────────────────────────────────────────

export function formatTokenCount(tokens: number): string {
	if (tokens < 1000) { return tokens.toString(); }
	if (tokens < 1_000_000) { return `${(tokens / 1000).toFixed(1)}K`; }
	return `${(tokens / 1_000_000).toFixed(2)}M`;
}

/** Formats a USD amount as CNY for display (¥). @deprecated 双币种数据请使用 formatCny(combineToCny(usd, cny))。 */
export function formatCost(costUsd: number): string {
	const cost = toCny(costUsd);
	if (cost < 0.01) { return `¥${cost.toFixed(4)}`; }
	if (cost < 1) { return `¥${cost.toFixed(3)}`; }
	return `¥${cost.toFixed(2)}`;
}

/** Formats an amount that is already in CNY (¥). */
export function formatCny(cny: number): string {
	if (cny < 0.01) { return `¥${cny.toFixed(4)}`; }
	if (cny < 1) { return `¥${cny.toFixed(3)}`; }
	return `¥${cny.toFixed(2)}`;
}

export function formatEnergy(wattHours: number): string {
	if (wattHours < 0.001) { return `${(wattHours * 1000).toFixed(2)} mWh`; }
	if (wattHours < 1000) { return `${wattHours.toFixed(2)} Wh`; }
	return `${(wattHours / 1000).toFixed(2)} kWh`;
}

export function formatCO2(grams: number): string {
	if (grams < 1) { return `${(grams * 1000).toFixed(0)} mg`; }
	if (grams < 1000) { return `${grams.toFixed(1)} g`; }
	return `${(grams / 1000).toFixed(2)} kg`;
}

/** Formats a USD amount as compact CNY (¥) for display in badges/tooltips. @deprecated 双币种数据请使用 formatCnyCompact(combineToCny(usd, cny))。 */
export function formatCostCompact(costUsd: number): string {
	const cost = toCny(costUsd);
	if (cost < 0.01) { return `¥${cost.toFixed(3)}`; }
	if (cost < 1000) { return `¥${cost.toFixed(2)}`; }
	if (cost < 1_000_000) { return `¥${(cost / 1000).toFixed(1)}K`; }
	return `¥${(cost / 1_000_000).toFixed(1)}M`;
}

/** Formats an amount that is already in CNY (¥) in a compact form. */
export function formatCnyCompact(cny: number): string {
	if (cny < 0.01) { return `¥${cny.toFixed(3)}`; }
	if (cny < 1000) { return `¥${cny.toFixed(2)}`; }
	if (cny < 1_000_000) { return `¥${(cny / 1000).toFixed(1)}K`; }
	return `¥${(cny / 1_000_000).toFixed(1)}M`;
}
