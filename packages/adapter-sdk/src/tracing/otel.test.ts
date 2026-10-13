import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROOT_CONTEXT, SpanStatusCode, TraceFlags, trace, type Attributes } from '@opentelemetry/api';
import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base';
import type { TraceSpan } from 'model-worklog-schema';

import { createModelLogger } from './logger';
import { ModelLoggerSpanExporter } from './otel';

async function readableSpan(attributes: Attributes = {}): Promise<ReadableSpan> {
	const memory = new InMemorySpanExporter();
	const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(memory)] });
	provider.getTracer('test').startSpan('fixture', { attributes }).end();
	await provider.forceFlush();
	const span = memory.getFinishedSpans()[0];
	assert.ok(span);
	await provider.shutdown();
	return span;
}

test('OTel exporter preserves parent IDs, nanosecond timestamps, status, events, links, and partial usage without global registration', async () => {
	const originalProvider = trace.getTracerProvider();
	const spans: TraceSpan[] = [];
	const logger = createModelLogger({
		projectId: 'otel', serviceName: 'instrumented', flushIntervalMs: 0,
		exporter: { export: async (batch) => { spans.push(...batch.spans); return { schemaVersion: 1, accepted: batch.spans.length, duplicates: 0 }; } },
	});
	const exporter = new ModelLoggerSpanExporter(logger);
	const provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
	const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: TraceFlags.SAMPLED, isRemote: true };
	const link = { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16), traceFlags: TraceFlags.SAMPLED };
	const span = provider.getTracer('auto-instrumentation').startSpan('llm', {
		startTime: [1_000, 123_456_789], links: [{ context: link }],
		attributes: {
			'openinference.span.kind': 'LLM', 'gen_ai.system': 'provider', 'gen_ai.request.model': 'model',
			'gen_ai.response.id': 'request', 'gen_ai.usage.input_tokens': 0, 'gen_ai.prompt': 'private-content',
		},
	}, trace.setSpanContext(ROOT_CONTEXT, parent));
	span.addEvent('tool', { 'tool.name': 'read', password: 'private-secret' }, [1_000, 500_000_000]);
	span.setStatus({ code: SpanStatusCode.ERROR, message: 'private-error' });
	span.end([1_001, 987_654_321]);
	await provider.forceFlush();
	await exporter.forceFlush();
	const final = spans.find((entry) => entry.revision === 2);
	assert.ok(final);
	assert.equal(final.traceId, parent.traceId);
	assert.equal(final.spanId, span.spanContext().spanId);
	assert.equal(final.parentSpanId, parent.spanId);
	assert.equal(final.startedAt, '1970-01-01T00:16:40.123456789Z');
	assert.equal(final.endedAt, '1970-01-01T00:16:41.987654321Z');
	assert.equal(final.state, 'failed');
	assert.equal(final.kind, 'model');
	assert.ok(final.capture.limitations.some((limitation) => limitation.includes('reconstructed')));
	assert.deepEqual(final.links, [{ traceId: link.traceId, spanId: link.spanId }]);
	assert.deepEqual(final.usage, { source: 'adapter-reported', provider: 'provider', model: 'model', requestId: 'request', inputTokens: 0 });
	assert.equal(final.events[0]?.attributes['tool.name'], 'read');
	assert.ok(!JSON.stringify(spans).includes('private-'));
	assert.equal(trace.getTracerProvider(), originalProvider);
	await provider.shutdown();
});

test('OpenInference token counts map only when present and ordinary spans have no invented usage', async () => {
	const source = await readableSpan();
	const inference = await readableSpan({ 'openinference.span.kind': 'LLM', 'llm.token_count.completion': 5 });
	const spans: TraceSpan[] = [];
	const logger = createModelLogger({ projectId: 'otel', serviceName: 'sdk', flushIntervalMs: 0,
		exporter: { export: async (batch) => { spans.push(...batch.spans); return { schemaVersion: 1, accepted: batch.spans.length, duplicates: 0 }; } },
	});
	const exporter = new ModelLoggerSpanExporter(logger);
	const first = await new Promise<ExportResult>((resolve) => exporter.export([inference], resolve));
	assert.equal(first.code, ExportResultCode.SUCCESS);
	await new Promise<ExportResult>((resolve) => exporter.export([source], resolve));
	assert.deepEqual(spans[1]?.usage, { source: 'adapter-reported', outputTokens: 5 });
	assert.equal(spans[3]?.usage, undefined);
	await exporter.shutdown();
});

test('OTel callbacks report failures once, flush and shutdown reject, and closed exporters reject new work', async () => {
	const source = await readableSpan();
	const logger = createModelLogger({ projectId: 'otel', serviceName: 'sdk', flushIntervalMs: 0, onDiagnostic: () => undefined,
		exporter: { export: async () => { throw new Error('private-exporter'); } },
	});
	const exporter = new ModelLoggerSpanExporter(logger);
	let callbacks = 0;
	const result = await new Promise<ExportResult>((resolve) => exporter.export([source], (outcome) => { callbacks += 1; resolve(outcome); }));
	assert.equal(result.code, ExportResultCode.FAILED);
	assert.ok(!result.error?.message.includes('private'));
	assert.equal(callbacks, 1);
	await assert.rejects(exporter.forceFlush(), /incomplete/);
	await assert.rejects(exporter.shutdown(), /incomplete/);
	const closed = await new Promise<ExportResult>((resolve) => exporter.export([source], resolve));
	assert.equal(closed.code, ExportResultCode.FAILED);
});

test('malformed OTel spans and callback exceptions become safe diagnostics', async () => {
	const source = await readableSpan();
	const diagnostics: unknown[] = [];
	const logger = createModelLogger({ projectId: 'otel', serviceName: 'sdk', flushIntervalMs: 0, onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
		exporter: { export: async (batch) => ({ schemaVersion: 1, accepted: batch.spans.length, duplicates: 0 }) },
	});
	const exporter = new ModelLoggerSpanExporter(logger);
	const malformed = { ...source, spanContext: () => { throw new Error('private-context'); } };
	const result = await new Promise<ExportResult>((resolve) => exporter.export([malformed], resolve));
	assert.equal(result.code, ExportResultCode.FAILED);
	exporter.export([], () => { throw new Error('private-callback'); });
	assert.ok(diagnostics.length >= 2);
	assert.ok(!JSON.stringify(diagnostics).includes('private'));
	await assert.rejects(exporter.shutdown());
});