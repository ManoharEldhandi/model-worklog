import assert from 'node:assert/strict';
import test from 'node:test';

import { otlpBatch, OTLP_FALLBACK_SERVICE } from './convert';
import { decodeOtlp } from './decode';
import { jsonRequest, jsonSpan, wireRequest, wireSpan } from './fixtures.test';
import type { OtlpRequest, OtlpSpan } from './protocol';

function convert(input: OtlpRequest) {
	return otlpBatch(decodeOtlp(Buffer.from(JSON.stringify(input)), 'json'), 'project').spans[0]!;
}

test('OTLP conversion retains final state, parent, links, events, typed nested values and instrumentation context', () => {
	const span = otlpBatch(decodeOtlp(wireRequest(wireSpan()), 'protobuf'), 'project').spans[0]!;
	assert.equal(span.state, 'failed');
	assert.equal(span.revision, 1);
	assert.equal(span.kind, 'model');
	assert.equal(span.serviceName, 'otlp-test');
	assert.equal(span.parentSpanId, '1111111111111111');
	assert.equal(span.startedAt, '2026-10-13T00:00:00.123Z');
	assert.equal(span.endedAt, '2026-10-13T00:00:01.123Z');
	assert.deepEqual(span.attributes.nested, { values: [true, '-9223372036854775808', 1.25, 'AP8=', null] });
	assert.deepEqual(span.links, [{ traceId: 'fedcba9876543210fedcba9876543210', spanId: '2222222222222222' }]);
	assert.deepEqual(span.events, [{ name: 'checkpoint', at: '2026-10-13T00:00:00.123Z', attributes: { ok: false } }]);
	assert.equal(span.usage?.source, 'adapter-reported');
	assert.equal(span.usage?.inputTokens, 7);
	assert.equal(span.usage?.totalTokens, undefined);
	assert.equal(span.capture.droppedEvents, 4);
	assert.ok(span.capture.truncatedFields > 0);
	assert.ok(span.capture.limitations.some((entry) => entry.includes('milliseconds')));
	assert.ok(JSON.stringify(span.attributes.otlp).includes('test.instrumentation'));
	assert.ok(JSON.stringify(span.attributes.otlp).includes('link=value'));
});

test('OTLP semantic kind and bounded service fallback never infer a running span', () => {
	const make = (attributes: OtlpSpan['attributes']) => convert(jsonRequest([jsonSpan({ attributes, status: undefined, parentSpanId: '' })]));
	for (const [operation, kind] of [['chat', 'model'], ['embeddings', 'embedding'], ['invoke_agent', 'agent'], ['execute_tool', 'tool'], ['retrieval', 'retrieval'], ['invoke_workflow', 'workflow']]) {
		assert.equal(make([{ key: 'gen_ai.operation.name', value: { stringValue: operation } }]).kind, kind);
	}
	assert.equal(make([{ key: 'openinference.span.kind', value: { stringValue: 'LLM' } }]).kind, 'model');
	assert.equal(make([{ key: 'openinference.span.kind', value: { stringValue: 'CHAIN' } }]).kind, 'workflow');
	assert.equal(make([]).kind, 'custom');
	assert.equal(make([]).state, 'completed');
	assert.equal(make([]).parentSpanId, undefined);
	for (const service of [undefined, { intValue: '7' }, { stringValue: '' }, { stringValue: 'x'.repeat(129) }]) {
		const input = jsonRequest();
		input.resourceSpans![0]!.resource = { attributes: [{ key: 'service.name', value: service }] };
		assert.equal(convert(input).serviceName, OTLP_FALLBACK_SERVICE);
	}
});

test('OTLP usage preserves unknown, partial, explicit zero, exact numeric counts and both semantic conventions', () => {
	const withUsage = (attributes: OtlpSpan['attributes']) => convert(jsonRequest([jsonSpan({ attributes })])).usage;
	assert.equal(withUsage([]), undefined);
	assert.equal(withUsage([{ key: 'gen_ai.usage.input_tokens', value: { stringValue: '42' } }]), undefined);
	for (const value of [{ intValue: '-1' }, { doubleValue: 0.5 }, { doubleValue: 'NaN' }, { intValue: '9007199254740993' }]) {
		assert.equal(withUsage([{ key: 'gen_ai.usage.input_tokens', value }]), undefined);
	}
	const partial = withUsage([{ key: 'gen_ai.usage.output_tokens', value: { intValue: '0' } }])!;
	assert.equal(partial.outputTokens, 0);
	assert.equal(partial.inputTokens, undefined);
	assert.equal(partial.totalTokens, undefined);
	const usage = withUsage([
		{ key: 'llm.token_count.prompt', value: { intValue: '7' } }, { key: 'llm.token_count.completion', value: { doubleValue: 0 } },
		{ key: 'llm.token_count.total', value: { intValue: '7' } }, { key: 'gen_ai.usage.cache_read.input_tokens', value: { intValue: '2' } },
		{ key: 'gen_ai.usage.cache_creation.input_tokens', value: { intValue: '0' } }, { key: 'gen_ai.usage.reasoning.output_tokens', value: { intValue: '0' } },
	])!;
	assert.equal(usage.totalTokens, 7);
	assert.equal(usage.cacheReadTokens, 2);
	assert.equal(usage.cacheWriteTokens, 0);
	assert.equal(usage.reasoningTokens, 0);
	assert.equal(withUsage([{ key: 'gen_ai.usage.cache_read.input_tokens', value: { intValue: '2' } }]), undefined);
});

test('raw reasoning chunks and events are removed before intake while numeric reasoning usage and visible content remain', () => {
	const span = convert(jsonRequest([jsonSpan({
		attributes: [
			{ key: 'gen_ai.output.messages', value: { stringValue: JSON.stringify([{ role: 'assistant', parts: [{ type: 'reasoning', content: 'private encoded thought' }, { type: 'text', content: 'visible answer' }] }]) } },
			{ key: 'gen_ai.reasoning', value: { stringValue: 'private flattened thought' } },
			{ key: 'parts.0.type', value: { stringValue: 'thinking' } }, { key: 'parts.0.text', value: { stringValue: 'private flat block' } },
			{ key: 'gen_ai.usage.output_tokens', value: { intValue: '1' } }, { key: 'gen_ai.usage.reasoning.output_tokens', value: { intValue: '1' } },
			{ key: 'content', value: { arrayValue: { values: [{ kvlistValue: { values: [{ key: 'type', value: { stringValue: 'thinking' } }, { key: 'text', value: { stringValue: 'private nested thought' } }] } }] } } },
		],
		events: [{ name: 'gen_ai.reasoning.chunk', timeUnixNano: jsonSpan().startTimeUnixNano, attributes: [{ key: 'text', value: { stringValue: 'private event thought' } }] }],
	})]));
	assert.equal(JSON.stringify(span).includes('private'), false);
	assert.ok(JSON.stringify(span).includes('visible answer'));
	assert.equal(span.events.length, 0);
	assert.equal(span.capture.droppedEvents, 5);
	assert.ok(span.capture.redactedFields >= 4);
	assert.equal(span.usage?.reasoningTokens, 1);
	assert.equal(span.attributes['gen_ai.usage.reasoning.output_tokens'], 1);
});

test('invalid final spans, duplicate keys and conflicting nanosecond ordering fail the entire conversion', () => {
	for (const overrides of [
		{ name: '' }, { name: 'x'.repeat(257) }, { endTimeUnixNano: undefined }, { startTimeUnixNano: undefined },
		{ endTimeUnixNano: '1791849600123456788' }, { parentSpanId: jsonSpan().spanId },
		{ attributes: [{ key: 'same', value: {} }, { key: 'same', value: {} }] },
		{ attributes: [{ key: '__proto__', value: {} }] }, { links: [{}] },
	]) { assert.throws(() => convert(jsonRequest([jsonSpan(), jsonSpan(overrides)])), { status: 400 }); }
	assert.throws(() => convert({}), { status: 400 });
});

test('retained OTLP context never overwrites application attributes with matching names', () => {
	const span = convert(jsonRequest([jsonSpan({ attributes: [
		{ key: 'otlp', value: { stringValue: 'application attribute' } },
		{ key: 'otlp.context.1', value: { stringValue: 'another application attribute' } },
	] })]));
	assert.equal(span.attributes.otlp, 'application attribute');
	assert.equal(span.attributes['otlp.context.1'], 'another application attribute');
	assert.ok(JSON.stringify(span.attributes['otlp.context.2']).includes('test.instrumentation'));
});