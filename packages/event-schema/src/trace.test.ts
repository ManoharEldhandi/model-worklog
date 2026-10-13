import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isBoundedJson, SpanUsageSchema, TraceSpanSchema } from './trace';
import { redactAttributes } from './privacy';

test('trace boundaries reject invalid IDs, forged provenance, cycles and dangerous objects', () => {
	const span = { schemaVersion: 1, projectId: 'example', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'agent', serviceName: 'test', kind: 'agent', startedAt: '2026-10-13T00:00:00.000Z', state: 'running', revision: 1, attributes: {}, events: [], links: [], capture: redactAttributes({}).report };
	assert.equal(TraceSpanSchema.safeParse(span).success, true);
	assert.equal(TraceSpanSchema.safeParse({ ...span, evidenceGrade: 'observed-native' }).success, false);
	assert.equal(TraceSpanSchema.safeParse({ ...span, traceId: '0'.repeat(32) }).success, false);
	assert.equal(TraceSpanSchema.safeParse({ ...span, state: 'completed' }).success, false);
	assert.equal(TraceSpanSchema.safeParse({ ...span, parentSpanId: span.spanId }).success, false);
	const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
	assert.equal(isBoundedJson(cyclic), false);
	assert.equal(isBoundedJson(JSON.parse('{"__proto__":{"polluted":true}}')), false);
	assert.equal(isBoundedJson({ bad: Number.NaN }), false);
	assert.equal(isBoundedJson(new Date()), false);
});

test('privacy defaults to metadata and never evaluates getters or retains hidden reasoning', () => {
	let getterCalled = false;
	const input = { 'gen_ai.request.model': 'example', prompt: 'private request', get secret() { getterCalled = true; return 'secret'; } };
	const metadata = redactAttributes(input);
	assert.deepEqual({ ...metadata.attributes }, { 'gen_ai.request.model': 'example' });
	assert.equal(getterCalled, false);
	const content = redactAttributes({ output: 'password=example', nested: { thinking: 'private', result: 'visible' }, cycle: input }, { mode: 'redacted-content' });
	assert.equal(JSON.stringify(content.attributes).includes('password=example'), false);
	assert.equal(JSON.stringify(content.attributes).includes('"thinking"'), false);
	assert.ok(content.report.redactedFields > 0);
});

test('privacy snapshots are detached and bound unsupported and oversized values', () => {
	const source = { output: { value: 'x'.repeat(200) } };
	const clean = redactAttributes(source, { mode: 'redacted-content', maxStringLength: 32 });
	source.output.value = 'changed';
	assert.equal(JSON.stringify(clean).includes('changed'), false);
	assert.equal(clean.report.truncatedFields, 1);
	const cyclic: Record<string, unknown> = {}; cyclic.value = cyclic;
	assert.doesNotThrow(() => redactAttributes(cyclic, { mode: 'redacted-content' }));
});

test('content opt-in still excludes typed private reasoning and plain token credentials', () => {
	const clean = redactAttributes({ token: 'private-bearer', output: [
		{ type: 'reasoning', text: 'private-chain' },
		{ type: 'thinking_delta', delta: 'private-chain' },
		{ type: 'text', text: 'visible answer' },
	] }, { mode: 'redacted-content' });
	assert.equal(JSON.stringify(clean).includes('private-'), false);
	assert.equal(JSON.stringify(clean).includes('visible answer'), true);
	assert.ok(clean.report.redactedFields >= 3);
	assert.equal(SpanUsageSchema.safeParse({ source: 'provider-reported', outputTokens: 1, reasoningTokens: 2 }).success, false);
	const oversized = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`field${index}`, index]));
	assert.equal(redactAttributes(oversized).report.truncatedFields, 1);
});

test('all intake paths remove provider reasoning variants and redaction is repeatable', () => {
	const policy = { mode: 'redacted-content' as const };
	const first = redactAttributes({ output: { choices: [{ message: {
		reasoning_content: 'PRIVATE', reasoning_text: 'PRIVATE', reasoning_details: [{ type: 'reasoning.text', text: 'PRIVATE' }], content: 'public',
	} }] }, event: { type: 'reasoning.text', text: 'PRIVATE' }, token: 'PRIVATE' }, policy);
	assert.equal(JSON.stringify(first).includes('PRIVATE'), false);
	assert.equal(JSON.stringify(first).includes('public'), true);
	const second = redactAttributes(first.attributes, policy);
	assert.deepEqual(second.attributes, first.attributes);
	assert.equal(second.report.redactedFields, 0);
});