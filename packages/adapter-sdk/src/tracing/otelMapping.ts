import { SpanStatusCode, type Attributes } from '@opentelemetry/api';
import { hrTimeToTimeStamp } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { SpanUsageSchema, type SpanKind, type SpanUsage, type TraceSpan } from 'model-worklog-schema';

import { emptyReport, OTEL_START_LIMITATION, type CaptureSettings } from './privacy';

type CountKey = 'inputTokens' | 'outputTokens' | 'totalTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens';

const tokenAttributes: Record<CountKey, readonly string[]> = {
	inputTokens: ['gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'llm.token_count.prompt'],
	outputTokens: ['gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'llm.token_count.completion'],
	totalTokens: ['gen_ai.usage.total_tokens', 'llm.token_count.total'],
	cacheReadTokens: ['gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_read_input_tokens', 'llm.token_count.prompt_details.cache_read'],
	cacheWriteTokens: ['gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_creation_input_tokens', 'llm.token_count.prompt_details.cache_write'],
	reasoningTokens: ['gen_ai.usage.reasoning_tokens', 'gen_ai.usage.reasoning.output_tokens', 'llm.token_count.completion_details.reasoning'],
};

function usage(attributes: Attributes): SpanUsage | undefined {
	const candidate: SpanUsage = { source: 'adapter-reported' };
	for (const key of Object.keys(tokenAttributes) as CountKey[]) {
		const count = tokenAttributes[key].map((name) => attributes[name]).find((value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
		if (typeof count === 'number') { candidate[key] = count; }
	}
	const identity = {
		provider: attributes['gen_ai.provider.name'] ?? attributes['gen_ai.system'],
		model: attributes['gen_ai.response.model'] ?? attributes['gen_ai.request.model'] ?? attributes['llm.model_name'],
		requestId: attributes['gen_ai.response.id'],
	};
	for (const key of ['provider', 'model', 'requestId'] as const) {
		const value = identity[key];
		if (typeof value === 'string' && value.length > 0) { candidate[key] = value; }
	}
	return SpanUsageSchema.safeParse(candidate).data;
}

function kind(attributes: Attributes): SpanKind {
	const openInference: Readonly<Record<string, SpanKind>> = {
		AGENT: 'agent', LLM: 'model', CHAIN: 'workflow', TOOL: 'tool', RETRIEVER: 'retrieval', EMBEDDING: 'embedding', RERANKER: 'rerank',
	};
	const declared = attributes['openinference.span.kind'];
	if (typeof declared === 'string' && Object.hasOwn(openInference, declared.toUpperCase())) { return openInference[declared.toUpperCase()] ?? 'custom'; }
	const operation = attributes['gen_ai.operation.name'];
	if (operation === 'embeddings') { return 'embedding'; }
	if (operation === 'invoke_agent') { return 'agent'; }
	if (operation === 'execute_tool') { return 'tool'; }
	if (typeof attributes['gen_ai.request.model'] === 'string' || ['chat', 'text_completion', 'generate_content'].includes(String(operation))) { return 'model'; }
	return 'custom';
}

export function otelSnapshots(
	span: ReadableSpan, identity: { readonly projectId: string; readonly serviceName: string }, settings: CaptureSettings,
): readonly [TraceSpan, TraceSpan] {
	if (!span.ended) { throw new Error('Only completed OpenTelemetry spans can be exported.'); }
	const context = span.spanContext();
	if (span.parentSpanContext !== undefined && span.parentSpanContext.traceId !== context.traceId) { throw new Error('Invalid OpenTelemetry parent context.'); }
	const startedAt = hrTimeToTimeStamp(span.startTime);
	const capture = emptyReport(settings);
	capture.limitations.push(OTEL_START_LIMITATION);
	capture.droppedEvents = span.droppedEventsCount + Math.max(0, span.events.length - 128);
	capture.truncatedFields = span.droppedAttributesCount + span.droppedLinksCount + Math.max(0, span.links.length - 128);
	const start: TraceSpan = {
		schemaVersion: 1, projectId: identity.projectId, serviceName: identity.serviceName,
		traceId: context.traceId, spanId: context.spanId,
		...(span.parentSpanContext === undefined ? {} : { parentSpanId: span.parentSpanContext.spanId }),
		name: span.name, kind: kind(span.attributes), startedAt, state: 'running', revision: 1,
		attributes: {}, events: [], links: span.links.slice(0, 128).map((link) => ({ traceId: link.context.traceId, spanId: link.context.spanId })),
		capture: { ...emptyReport(settings), limitations: [...capture.limitations] },
	};
	return [start, {
		...start, revision: 2, endedAt: hrTimeToTimeStamp(span.endTime), state: span.status.code === SpanStatusCode.ERROR ? 'failed' : 'completed',
		attributes: Object.fromEntries(Object.entries(span.attributes).filter((entry): entry is [string, string | number | boolean | (string | null)[] | (number | null)[] | (boolean | null)[]] => entry[1] !== undefined)),
		events: span.events.slice(0, 128).map((event) => ({ name: event.name, at: hrTimeToTimeStamp(event.time), attributes: Object.fromEntries(Object.entries(event.attributes ?? {}).filter((entry) => entry[1] !== undefined)) as TraceSpan['attributes'] })),
		usage: usage(span.attributes), capture,
	}];
}