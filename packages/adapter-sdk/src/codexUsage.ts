import { normalizeOpenAIUsage, type UsageNormalization } from './usage';

const record = (value: unknown): Record<string, unknown> | undefined => typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Adapt the app-server cumulative counters, never the last-request subtotal. */
export function codexUsageResponse(value: unknown): unknown {
	const root = record(value); const usage = record(root?.tokenUsage);
	if (root === undefined || root.tokenUsage === undefined) { return value; }
	const total = record(usage?.total);
	return { model: root.model, usage: total === undefined ? undefined : {
		input_tokens: total.inputTokens, output_tokens: total.outputTokens, total_tokens: total.totalTokens,
		input_tokens_details: { cached_tokens: total.cachedInputTokens, cache_write_tokens: total.cacheWriteInputTokens },
		output_tokens_details: { reasoning_tokens: total.reasoningOutputTokens },
	} };
}

export function normalizeCodexUsage(value: unknown): UsageNormalization {
	const normalized = normalizeOpenAIUsage(codexUsageResponse(value));
	if (!normalized.ok) { return normalized; }
	const usage = normalized.usage;
	const counts = [usage.inputTokens, usage.outputTokens, usage.totalTokens, usage.cacheReadTokens, usage.cacheWriteTokens, usage.reasoningTokens];
	if (counts.some((count) => count !== undefined && !Number.isSafeInteger(count))
		|| (usage.inputTokens !== undefined && usage.outputTokens !== undefined && usage.totalTokens !== usage.inputTokens + usage.outputTokens)
		|| (usage.inputTokens !== undefined && (usage.cacheReadTokens ?? 0) > usage.inputTokens)) {
		return { ok: false, reason: 'adapter-error', message: 'Codex reported inconsistent or unsafe token counters.' };
	}
	return normalized;
}
