import { SpanUsageSchema, type SpanUsage } from 'model-worklog-schema';

import { normalizeProviderUsage, type TokenUsageMapping, type UsageProviderSelector } from '../usage';

type CountKey = 'inputTokens' | 'outputTokens' | 'totalTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens';

function field(input: unknown, path: string): unknown {
	let current = input;
	for (const segment of path.split('.')) {
		if (typeof current !== 'object' || current === null || ['__proto__', 'constructor', 'prototype'].includes(segment)) { return undefined; }
		const descriptor = Object.getOwnPropertyDescriptor(current, segment);
		if (descriptor === undefined || !('value' in descriptor)) { return undefined; }
		current = descriptor.value as unknown;
	}
	return current;
}

function partialUsage(provider: UsageProviderSelector, response: unknown, mapping?: TokenUsageMapping): SpanUsage | undefined {
	let selected = provider;
	if (selected === 'auto' && mapping === undefined) {
		selected = field(response, 'usageMetadata') !== undefined ? 'gemini'
			: field(response, 'type') === 'message' ? 'anthropic'
				: ['response', 'chat.completion'].includes(String(field(response, 'object'))) || field(response, 'response') !== undefined ? 'openai' : 'auto';
	}
	if (selected === 'auto' && mapping === undefined) { return undefined; }
	const root = mapping === undefined && (selected === 'openai' || selected === 'openai-compatible') ? field(response, 'response') ?? response : response;
	const paths: Record<CountKey, readonly string[]> = mapping !== undefined ? {
		inputTokens: [mapping.inputTokens ?? ''], outputTokens: [mapping.outputTokens ?? ''], totalTokens: [mapping.totalTokens ?? ''],
		cacheReadTokens: [mapping.cacheReadTokens ?? ''], cacheWriteTokens: [mapping.cacheWriteTokens ?? ''], reasoningTokens: [mapping.reasoningTokens ?? ''],
	} : selected === 'gemini' ? {
		inputTokens: ['usageMetadata.promptTokenCount'], outputTokens: ['usageMetadata.candidatesTokenCount'], totalTokens: ['usageMetadata.totalTokenCount'],
		cacheReadTokens: ['usageMetadata.cachedContentTokenCount'], cacheWriteTokens: [], reasoningTokens: ['usageMetadata.thoughtsTokenCount'],
	} : {
		inputTokens: ['usage.input_tokens', 'usage.prompt_tokens'], outputTokens: ['usage.output_tokens', 'usage.completion_tokens'], totalTokens: ['usage.total_tokens'],
		cacheReadTokens: ['usage.cache_read_input_tokens', 'usage.input_tokens_details.cached_tokens', 'usage.prompt_tokens_details.cached_tokens'],
		cacheWriteTokens: ['usage.cache_creation_input_tokens', 'usage.input_tokens_details.cache_write_tokens'],
		reasoningTokens: ['usage.output_tokens_details.reasoning_tokens', 'usage.completion_tokens_details.reasoning_tokens', 'usage.output_tokens_details.thinking_tokens'],
	};
	const usage: SpanUsage = { source: 'provider-reported', provider: mapping?.provider ?? selected };
	for (const key of Object.keys(paths) as CountKey[]) {
		const value = paths[key].map((path) => path === '' ? undefined : field(root, path)).find((entry) => entry !== undefined && entry !== null);
		if (value !== undefined) {
			if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) { return undefined; }
			usage[key] = value;
		}
	}
	const model = field(root, mapping?.model ?? (selected === 'gemini' ? 'modelVersion' : 'model'));
	const requestId = field(root, mapping?.providerResponseId ?? (selected === 'gemini' ? 'responseId' : 'id'));
	if (typeof model === 'string') { usage.model = model; }
	if (typeof requestId === 'string') { usage.requestId = requestId; }
	return SpanUsageSchema.safeParse(usage).data;
}

export function providerUsage(provider: UsageProviderSelector, response: unknown, mapping?: TokenUsageMapping): SpanUsage | undefined {
	const normalized = normalizeProviderUsage(provider, response, mapping);
	if (!normalized.ok) {
		return normalized.reason === 'not-observed' ? partialUsage(provider, response, mapping) : undefined;
	}
	const { providerResponseId, ...usage } = normalized.usage;
	return SpanUsageSchema.safeParse({ ...usage, ...(providerResponseId === undefined ? {} : { requestId: providerResponseId }) }).data;
}