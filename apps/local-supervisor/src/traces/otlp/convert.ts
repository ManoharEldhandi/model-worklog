import { TraceBatchSchema, type CaptureReport, type JsonObject, type SpanKind, type SpanUsage, type TraceBatch, type TraceSpan } from 'model-worklog-schema';

import { TraceError } from '../domain/contracts';
import { attributes, isReasoning, limitation, withoutReasoning } from './attributes';
import type { OtlpRequest, OtlpSpan, ResourceSpans, ScopeSpans } from './protocol';
import { invalidOtlp } from './validation';

export const OTLP_FALLBACK_SERVICE = 'unknown_service';

const operations: Record<string, SpanKind> = {
	chat: 'model', text_completion: 'model', generate_content: 'model', embeddings: 'embedding',
	create_agent: 'agent', invoke_agent: 'agent', execute_tool: 'tool', retrieval: 'retrieval', invoke_workflow: 'workflow',
};
const inferenceKinds: Record<string, SpanKind> = {
	LLM: 'model', AGENT: 'agent', TOOL: 'tool', RETRIEVER: 'retrieval', EMBEDDING: 'embedding', RERANKER: 'rerank', CHAIN: 'workflow',
};

function spanKind(input: JsonObject): SpanKind {
	const operation = input['gen_ai.operation.name'];
	const inference = input['openinference.span.kind'];
	return (typeof operation === 'string' && Object.hasOwn(operations, operation) ? operations[operation] : undefined)
		?? (typeof inference === 'string' && Object.hasOwn(inferenceKinds, inference.toUpperCase()) ? inferenceKinds[inference.toUpperCase()] : undefined) ?? 'custom';
}

function usage(input: JsonObject, report: CaptureReport): SpanUsage | undefined {
	const count = (...keys: string[]): number | undefined => {
		for (const key of keys) {
			const entry = input[key];
			if (typeof entry === 'number' && Number.isSafeInteger(entry) && entry >= 0) { return entry; }
		}
		return undefined;
	};
	const text = (maximum: number, ...keys: string[]): string | undefined => {
		for (const key of keys) {
			const entry = input[key];
			if (typeof entry === 'string' && entry.length > 0 && entry.length <= maximum) { return entry; }
		}
		return undefined;
	};
	const inputTokens = count('gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'llm.token_count.prompt');
	const outputTokens = count('gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'llm.token_count.completion');
	const totalTokens = count('gen_ai.usage.total_tokens', 'llm.token_count.total');
	const cacheReadTokens = count('gen_ai.usage.cache_read.input_tokens', 'llm.token_count.prompt_details.cache_read');
	const cacheWriteTokens = count('gen_ai.usage.cache_creation.input_tokens', 'llm.token_count.prompt_details.cache_write');
	const reasoningTokens = count('gen_ai.usage.reasoning.output_tokens', 'llm.token_count.completion_details.reasoning');
	if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
		if (cacheReadTokens !== undefined || cacheWriteTokens !== undefined || reasoningTokens !== undefined) {
			limitation(report, 'Cache/reasoning-only counts remain attributes; the usage contract requires an input, output or total count.');
		}
		return undefined;
	}
	return {
		source: 'adapter-reported', inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens,
		provider: text(128, 'gen_ai.provider.name', 'gen_ai.system', 'llm.provider'),
		model: text(128, 'gen_ai.response.model', 'gen_ai.request.model', 'llm.model_name'), requestId: text(256, 'gen_ai.response.id'),
	};
}

function timestamp(input: string | undefined): string {
	if (input === undefined) { invalidOtlp(); }
	return new Date(Number(BigInt(input) / 1_000_000n)).toISOString();
}

function convertSpan(span: OtlpSpan, resource: ResourceSpans, scope: ScopeSpans, projectId: string): TraceSpan {
	const capture: CaptureReport = {
		mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: span.droppedEventsCount ?? 0,
		limitations: [
			'OTLP terminal spans are stored as revision 1; timestamps are floored to milliseconds from exact nanoseconds.',
			'Unknown OTLP message fields are ignored for forward compatibility.',
			'Recognized raw reasoning content is removed; operator privacy applies to all retained OTLP content.',
		],
	};
	const resourceAttributes = attributes(resource.resource?.attributes, capture);
	const scopeAttributes = attributes(scope.scope?.attributes, capture);
	const spanAttributes = attributes(span.attributes, capture);
	const service = resourceAttributes['service.name'];
	const serviceName = typeof service === 'string' && service.length > 0 && service.length <= 128 ? service : OTLP_FALLBACK_SERVICE;
	if (serviceName === OTLP_FALLBACK_SERVICE && service !== OTLP_FALLBACK_SERVICE) { limitation(capture, 'Missing or invalid resource service.name uses unknown_service (1 to 128 characters required).'); }
	if (span.startTimeUnixNano === undefined || span.endTimeUnixNano === undefined || BigInt(span.endTimeUnixNano) < BigInt(span.startTimeUnixNano)) { invalidOtlp(); }
	const events: TraceSpan['events'] = [];
	for (const event of span.events ?? []) {
		const eventAttributes = attributes(event.attributes, capture);
		const at = timestamp(event.timeUnixNano);
		if (event.name === undefined || event.name.length === 0 || event.name.length > 256) { invalidOtlp(); }
		capture.truncatedFields += event.droppedAttributesCount ?? 0;
		if (isReasoning(event.name) || isReasoning(eventAttributes)) { capture.droppedEvents += 1; continue; }
		events.push({ name: event.name, at, attributes: (withoutReasoning(eventAttributes, capture) ?? {}) as JsonObject });
	}
	const links = (span.links ?? []).map((link) => {
		const linkAttributes = attributes(link.attributes, capture);
		capture.truncatedFields += link.droppedAttributesCount ?? 0;
		return { traceId: link.traceId ?? '', spanId: link.spanId ?? '', traceState: link.traceState ?? '', flags: link.flags ?? 0,
			attributes: linkAttributes, droppedAttributesCount: link.droppedAttributesCount ?? 0 };
	});
	const metadata: JsonObject = {
		resource: { attributes: resourceAttributes, schemaUrl: resource.schemaUrl ?? '', droppedAttributesCount: resource.resource?.droppedAttributesCount ?? 0,
			entityRefs: (resource.resource?.entityRefs ?? []).map((entity) => ({ schemaUrl: entity.schemaUrl ?? '', type: entity.type ?? '', idKeys: entity.idKeys ?? [], descriptionKeys: entity.descriptionKeys ?? [] })) },
		scope: { name: scope.scope?.name ?? '', version: scope.scope?.version ?? '', attributes: scopeAttributes, schemaUrl: scope.schemaUrl ?? '', droppedAttributesCount: scope.scope?.droppedAttributesCount ?? 0 },
		span: { traceState: span.traceState ?? '', kind: span.kind ?? 0, flags: span.flags ?? 0, status: { code: span.status?.code ?? 0, message: span.status?.message ?? '' },
			startTimeUnixNano: span.startTimeUnixNano, endTimeUnixNano: span.endTimeUnixNano,
			droppedAttributesCount: span.droppedAttributesCount ?? 0, droppedLinksCount: span.droppedLinksCount ?? 0 },
		links,
	};
	let metadataKey = 'otlp';
	for (let suffix = 1; Object.hasOwn(spanAttributes, metadataKey); suffix += 1) { metadataKey = `otlp.context.${suffix}`; }
	capture.truncatedFields += (resource.resource?.droppedAttributesCount ?? 0) + (scope.scope?.droppedAttributesCount ?? 0) + (span.droppedAttributesCount ?? 0) + (span.droppedLinksCount ?? 0);
	if (capture.truncatedFields > 0) { limitation(capture, 'The OTLP sender reported dropped attributes or links.'); }
	const spanUsage = usage(spanAttributes, capture);
	return {
		schemaVersion: 1, projectId, traceId: span.traceId ?? '', spanId: span.spanId ?? '', parentSpanId: span.parentSpanId || undefined,
		name: span.name ?? '', serviceName, kind: spanKind(spanAttributes), revision: 1, state: span.status?.code === 2 ? 'failed' : 'completed',
		startedAt: timestamp(span.startTimeUnixNano), endedAt: timestamp(span.endTimeUnixNano),
		attributes: (withoutReasoning({ ...spanAttributes, [metadataKey]: metadata }, capture) ?? {}) as JsonObject,
		events, links: links.map((link) => ({ traceId: link.traceId, spanId: link.spanId })), usage: spanUsage, capture,
	};
}

export function otlpBatch(input: OtlpRequest, projectId: string): TraceBatch {
	const spans: TraceSpan[] = [];
	for (const resource of input.resourceSpans ?? []) {
		for (const scope of resource.scopeSpans ?? []) {
			for (const span of scope.spans ?? []) {
				if (spans.length >= 100) { invalidOtlp(); }
				spans.push(convertSpan(span, resource, scope, projectId));
			}
		}
	}
	const parsed = TraceBatchSchema.safeParse({ schemaVersion: 1, spans });
	if (!parsed.success) { throw new TraceError(400, 'invalid_otlp_batch', 'OTLP must contain 1 to 100 final spans within the trace contract bounds, including retained OTLP context attributes.'); }
	return parsed.data;
}