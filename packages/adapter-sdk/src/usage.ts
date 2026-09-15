import type { TokenUsage, UnknownReason } from 'model-worklog-schema';

export const USAGE_PROVIDERS = ['openai', 'openai-compatible', 'anthropic', 'gemini'] as const;

export type UsageProvider = (typeof USAGE_PROVIDERS)[number];
export type UsageProviderSelector = UsageProvider | 'auto';
export type UsageUnavailableReason = Extract<UnknownReason, 'not-observed' | 'unsupported-capability' | 'ambiguous' | 'adapter-error'>;

export interface TokenUsageMapping {
	readonly provider: string;
	readonly inputTokens?: string;
	readonly outputTokens?: string;
	readonly cacheReadTokens?: string;
	readonly cacheWriteTokens?: string;
	readonly reasoningTokens?: string;
	readonly totalTokens?: string;
	readonly model?: string;
	readonly providerResponseId?: string;
	readonly cacheTokensAreAdditional?: boolean;
}

export type UsageNormalization =
	| { readonly ok: true; readonly usage: TokenUsage }
	| { readonly ok: false; readonly reason: UsageUnavailableReason; readonly message: string };

interface NormalizationOptions {
	readonly allowComputedTotal?: boolean;
	readonly cacheTokensAreAdditional?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readPath(value: unknown, path: string): unknown {
	if (path.trim() === '') {
		throw new Error('mapping paths must not be empty');
	}
	let current: unknown = value;
	for (const segment of path.split('.')) {
		if (segment.trim() === '') {
			throw new Error(`invalid mapping path: ${path}`);
		}
		const record = asRecord(current);
		if (record === undefined || !(segment in record)) {
			return undefined;
		}
		current = record[segment];
	}
	return current;
}

function tokenCount(value: unknown, path: string): number | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new Error(`${path} must be a non-negative integer when present`);
	}
	return value;
}

function stringValue(value: unknown, path: string): string | undefined {
	if (value === undefined || value === null) {
		return undefined;
	}
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error(`${path} must be a non-empty string when present`);
	}
	return value;
}

function firstTokenCount(value: unknown, paths: readonly string[]): number | undefined {
	for (const path of paths) {
		const count = tokenCount(readPath(value, path), path);
		if (count !== undefined) {
			return count;
		}
	}
	return undefined;
}

function identity(value: unknown, modelPath: string, responseIdPath: string): Pick<TokenUsage, 'model' | 'providerResponseId'> {
	const model = stringValue(readPath(value, modelPath), modelPath);
	const providerResponseId = stringValue(readPath(value, responseIdPath), responseIdPath);
	return {
		...(model === undefined ? {} : { model }),
		...(providerResponseId === undefined ? {} : { providerResponseId }),
	};
}

function unavailable(reason: UsageUnavailableReason, message: string): UsageNormalization {
	return { ok: false, reason, message };
}

function normalizeError(error: unknown): UsageNormalization {
	return unavailable('adapter-error', error instanceof Error ? error.message : String(error));
}

function normalizedUsage(
	provider: string,
	identityFields: Pick<TokenUsage, 'model' | 'providerResponseId'>,
	counts: Omit<TokenUsage, 'source' | 'provider' | 'model' | 'providerResponseId'>,
	options: NormalizationOptions = {},
): UsageNormalization {
	const inputTokens = counts.inputTokens;
	const outputTokens = counts.outputTokens;
	const totalTokens = counts.totalTokens;
	const canComputeTotal = options.allowComputedTotal !== false && inputTokens !== undefined && outputTokens !== undefined;
	if (totalTokens === undefined && !canComputeTotal) {
		return unavailable('not-observed', 'The response did not include a total token count or complete input and output counts.');
	}
	if (counts.reasoningTokens !== undefined && outputTokens !== undefined && counts.reasoningTokens > outputTokens) {
		return unavailable('adapter-error', 'reasoningTokens cannot exceed outputTokens.');
	}
	const computedTotal = inputTokens === undefined || outputTokens === undefined
		? undefined
		: inputTokens + outputTokens + (options.cacheTokensAreAdditional === true ? (counts.cacheReadTokens ?? 0) + (counts.cacheWriteTokens ?? 0) : 0);
	const finalTotal = totalTokens ?? computedTotal;
	if (finalTotal === undefined) {
		return unavailable('not-observed', 'The response did not include a usable total token count.');
	}
	return {
		ok: true,
		usage: {
			source: totalTokens === undefined ? 'computed-from-provider-fields' : 'provider-reported',
			provider,
			...identityFields,
			...(inputTokens === undefined ? {} : { inputTokens }),
			...(outputTokens === undefined ? {} : { outputTokens }),
			...(counts.cacheReadTokens === undefined ? {} : { cacheReadTokens: counts.cacheReadTokens }),
			...(counts.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: counts.cacheWriteTokens }),
			...(counts.reasoningTokens === undefined ? {} : { reasoningTokens: counts.reasoningTokens }),
			totalTokens: finalTotal,
		},
	};
}

function usageRecord(response: unknown, path: string): Record<string, unknown> | undefined {
	return asRecord(readPath(response, path));
}

export function normalizeOpenAIUsage(response: unknown, provider: Extract<UsageProvider, 'openai' | 'openai-compatible'> = 'openai'): UsageNormalization {
	const root = asRecord(response);
	if (root === undefined) {
		return unavailable('not-observed', 'The provider response is not an object.');
	}
	const responseRoot = usageRecord(root, 'response') ?? root;
	const usage = usageRecord(responseRoot, 'usage');
	if (usage === undefined) {
		return unavailable('not-observed', 'The OpenAI response did not include a usage object.');
	}
	try {
		return normalizedUsage(provider, identity(responseRoot, 'model', 'id'), {
			inputTokens: firstTokenCount(usage, ['input_tokens', 'prompt_tokens']),
			outputTokens: firstTokenCount(usage, ['output_tokens', 'completion_tokens']),
			cacheReadTokens: firstTokenCount(usage, ['input_tokens_details.cached_tokens', 'prompt_tokens_details.cached_tokens']),
			cacheWriteTokens: firstTokenCount(usage, ['input_tokens_details.cache_write_tokens']),
			reasoningTokens: firstTokenCount(usage, ['output_tokens_details.reasoning_tokens', 'completion_tokens_details.reasoning_tokens']),
			totalTokens: firstTokenCount(usage, ['total_tokens']),
		});
	} catch (error) {
		return normalizeError(error);
	}
}

export function normalizeAnthropicUsage(response: unknown): UsageNormalization {
	const root = asRecord(response);
	if (root === undefined) {
		return unavailable('not-observed', 'The provider response is not an object.');
	}
	const usage = usageRecord(root, 'usage');
	if (usage === undefined) {
		return unavailable('not-observed', 'The Anthropic response did not include a usage object.');
	}
	try {
		return normalizedUsage('anthropic', identity(root, 'model', 'id'), {
			inputTokens: tokenCount(readPath(usage, 'input_tokens'), 'usage.input_tokens'),
			outputTokens: tokenCount(readPath(usage, 'output_tokens'), 'usage.output_tokens'),
			cacheReadTokens: tokenCount(readPath(usage, 'cache_read_input_tokens'), 'usage.cache_read_input_tokens'),
			cacheWriteTokens: tokenCount(readPath(usage, 'cache_creation_input_tokens'), 'usage.cache_creation_input_tokens'),
			reasoningTokens: tokenCount(readPath(usage, 'output_tokens_details.thinking_tokens'), 'usage.output_tokens_details.thinking_tokens'),
			totalTokens: tokenCount(readPath(usage, 'total_tokens'), 'usage.total_tokens'),
		}, { cacheTokensAreAdditional: true });
	} catch (error) {
		return normalizeError(error);
	}
}

export function normalizeGeminiUsage(response: unknown): UsageNormalization {
	const root = asRecord(response);
	if (root === undefined) {
		return unavailable('not-observed', 'The provider response is not an object.');
	}
	const usage = usageRecord(root, 'usageMetadata');
	if (usage === undefined) {
		return unavailable('not-observed', 'The Gemini response did not include usageMetadata.');
	}
	try {
		return normalizedUsage('gemini', identity(root, 'modelVersion', 'responseId'), {
			inputTokens: tokenCount(readPath(usage, 'promptTokenCount'), 'usageMetadata.promptTokenCount'),
			outputTokens: tokenCount(readPath(usage, 'candidatesTokenCount'), 'usageMetadata.candidatesTokenCount'),
			cacheReadTokens: tokenCount(readPath(usage, 'cachedContentTokenCount'), 'usageMetadata.cachedContentTokenCount'),
			reasoningTokens: tokenCount(readPath(usage, 'thoughtsTokenCount'), 'usageMetadata.thoughtsTokenCount'),
			totalTokens: tokenCount(readPath(usage, 'totalTokenCount'), 'usageMetadata.totalTokenCount'),
		}, { allowComputedTotal: false });
	} catch (error) {
		return normalizeError(error);
	}
}

export function normalizeMappedUsage(response: unknown, mapping: TokenUsageMapping): UsageNormalization {
	if (typeof mapping.provider !== 'string' || mapping.provider.trim() === '') {
		return unavailable('adapter-error', 'mapping.provider must be a non-empty string.');
	}
	try {
		return normalizedUsage(mapping.provider, {
			...(mapping.model === undefined ? {} : { model: stringValue(readPath(response, mapping.model), mapping.model) }),
			...(mapping.providerResponseId === undefined ? {} : { providerResponseId: stringValue(readPath(response, mapping.providerResponseId), mapping.providerResponseId) }),
		}, {
			...(mapping.inputTokens === undefined ? {} : { inputTokens: tokenCount(readPath(response, mapping.inputTokens), mapping.inputTokens) }),
			...(mapping.outputTokens === undefined ? {} : { outputTokens: tokenCount(readPath(response, mapping.outputTokens), mapping.outputTokens) }),
			...(mapping.cacheReadTokens === undefined ? {} : { cacheReadTokens: tokenCount(readPath(response, mapping.cacheReadTokens), mapping.cacheReadTokens) }),
			...(mapping.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: tokenCount(readPath(response, mapping.cacheWriteTokens), mapping.cacheWriteTokens) }),
			...(mapping.reasoningTokens === undefined ? {} : { reasoningTokens: tokenCount(readPath(response, mapping.reasoningTokens), mapping.reasoningTokens) }),
			...(mapping.totalTokens === undefined ? {} : { totalTokens: tokenCount(readPath(response, mapping.totalTokens), mapping.totalTokens) }),
		}, { cacheTokensAreAdditional: mapping.cacheTokensAreAdditional });
	} catch (error) {
		return normalizeError(error);
	}
}

export function normalizeProviderUsage(provider: UsageProviderSelector, response: unknown, mapping?: TokenUsageMapping): UsageNormalization {
	if (mapping !== undefined) {
		return normalizeMappedUsage(response, mapping);
	}
	if (provider === 'openai' || provider === 'openai-compatible') {
		return normalizeOpenAIUsage(response, provider);
	}
	if (provider === 'anthropic') {
		return normalizeAnthropicUsage(response);
	}
	if (provider === 'gemini') {
		return normalizeGeminiUsage(response);
	}

	const root = asRecord(response);
	if (root === undefined) {
		return unavailable('not-observed', 'The provider response is not an object.');
	}
	if (usageRecord(root, 'usageMetadata') !== undefined) {
		return normalizeGeminiUsage(root);
	}
	if (root.type === 'message') {
		return normalizeAnthropicUsage(root);
	}
	if (root.object === 'response' || root.object === 'chat.completion' || usageRecord(root, 'response') !== undefined) {
		return normalizeOpenAIUsage(root);
	}
	return unavailable('ambiguous', 'Could not determine the provider response format. Pass a provider or TokenUsageMapping explicitly.');
}