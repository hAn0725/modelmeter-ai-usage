/*---------------------------------------------------------------------------------------------
 *  Copyright (c) FeimaCode. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

/**
 * Session-level "输入上下文构成" (input context breakdown) aggregation.
 *
 * The importer stores, per turn, the provider-reported token share of the
 * prompt for five categories (flattened percentages). To aggregate a whole
 * session we must NOT average those percentages: turns have different prompt
 * sizes. Instead we convert each turn's share into approx tokens
 * (`promptTokens × pct / 100`), sum per category, and then normalize against
 * the prompt tokens of the turns that actually carried breakdown data —
 * i.e. a prompt-token-weighted aggregate.
 *
 * Only *some* turns may have breakdown data; those without any (all five
 * percentages are 0) stay out of the denominator and are surfaced through
 * `coverage` so the UI can say "构成数据覆盖 X% 输入 Token".
 *
 * Category token counts are approximations derived from percentages — UIs
 * must present them as “约 X Token”, never as provider-exact counts.
 */

export interface PromptBreakdownTurn {
	prompt_tokens: number;
	system_instructions_pct: number;
	tool_definitions_pct: number;
	messages_pct: number;
	files_pct: number;
	tool_results_pct: number;
}

export type ContextCategoryKey = 'system' | 'tools' | 'messages' | 'files' | 'toolResults';

export interface ContextCategoryAgg {
	key: ContextCategoryKey;
	/** Approx tokens (Σ promptTokens × pct / 100). */
	tokens: number;
	/** Share of the covered prompt tokens, in percent (0–100). */
	pct: number;
}

export interface SessionContextAggregate {
	categories: ContextCategoryAgg[];
	/** Prompt tokens of turns that carried breakdown data. */
	coveredPromptTokens: number;
	/** Prompt tokens of all turns. */
	totalPromptTokens: number;
	/** coveredPromptTokens / totalPromptTokens (0–1). */
	coverage: number;
	/** True when at least one turn carried breakdown data. */
	hasData: boolean;
}

const CATEGORY_KEYS: readonly ContextCategoryKey[] = ['system', 'tools', 'messages', 'files', 'toolResults'];

export function aggregateSessionContext(turns: readonly PromptBreakdownTurn[]): SessionContextAggregate {
	const tokensByCategory: Record<ContextCategoryKey, number> = {
		system: 0, tools: 0, messages: 0, files: 0, toolResults: 0,
	};
	let coveredPromptTokens = 0;
	let totalPromptTokens = 0;
	let hasData = false;

	for (const t of turns) {
		const prompt = Number.isFinite(t.prompt_tokens) && t.prompt_tokens > 0 ? t.prompt_tokens : 0;
		totalPromptTokens += prompt;
		const pcts = [t.system_instructions_pct, t.tool_definitions_pct, t.messages_pct, t.files_pct, t.tool_results_pct]
			.map(p => (Number.isFinite(p) && p > 0 ? p : 0));
		const sum = pcts.reduce((a, b) => a + b, 0);
		if (sum <= 0 || prompt <= 0) { continue; }
		hasData = true;
		coveredPromptTokens += prompt;
		for (let i = 0; i < CATEGORY_KEYS.length; i++) {
			tokensByCategory[CATEGORY_KEYS[i]] += (prompt * pcts[i]) / 100;
		}
	}

	const categories: ContextCategoryAgg[] = CATEGORY_KEYS.map(key => ({
		key,
		tokens: tokensByCategory[key],
		pct: coveredPromptTokens > 0 ? (tokensByCategory[key] / coveredPromptTokens) * 100 : 0,
	}));

	return {
		categories,
		coveredPromptTokens,
		totalPromptTokens,
		coverage: totalPromptTokens > 0 ? coveredPromptTokens / totalPromptTokens : 0,
		hasData,
	};
}
