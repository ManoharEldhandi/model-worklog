import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TraceSpanSchema, type TraceSpan } from 'model-worklog-schema';

import { formatTraceparent, parseTraceparent } from './context';
import { captureSettings, emptyReport, prepareSnapshot, safeAttributes } from './privacy';
import { providerUsage } from './usage';

test('traceparent helpers preserve remote identity and flags and reject invalid IDs', () => {
	const header = `00-${'a'.repeat(32)}-${'b'.repeat(16)}-00`;
	const context = parseTraceparent(header);
	assert.ok(context);
	assert.equal(context.isRemote, true);
	assert.equal(formatTraceparent(context), header);
	for (const invalid of [header.toUpperCase(), header.replace('a'.repeat(32), '0'.repeat(32)), `${header}-extra`, `ff${header.slice(2)}`]) {
		assert.equal(parseTraceparent(invalid), undefined);
	}
});

test('capture is metadata-first and content opt-in still drops reasoning, secrets, and getters', () => {
	const input = { 'gen_ai.request.model': 'model', prompt: 'private prompt', 'gen_ai.reasoning': 'hidden', nested: { password: 'private', reasoning: 'hidden' } };
	Object.defineProperty(input, 'getter', { enumerable: true, get: () => { throw new Error('must not run'); } });
	assert.deepEqual(safeAttributes(input, captureSettings()).attributes, { 'gen_ai.request.model': 'model' });
	const clean = safeAttributes(input, captureSettings({ mode: 'redacted-content' }));
	assert.equal(clean.attributes.prompt, 'private prompt');
	assert.equal(clean.attributes['gen_ai.reasoning'], undefined);
	assert.deepEqual({ ...clean.attributes.nested as Record<string, unknown> }, { password: '[REDACTED]' });
	assert.ok(clean.report.redactedFields >= 3);
	assert.equal(input.nested.password, 'private');
});

test('snapshots are schema-valid, detached, deeply frozen, and byte bounded', () => {
	const settings = captureSettings({ mode: 'redacted-content' }, { maxSpanBytes: 2_048, maxAttributeBytes: 1_024, maxEvents: 2 });
	const input: TraceSpan = {
		schemaVersion: 1, projectId: 'test', serviceName: 'sdk', name: 'name'.repeat(100), kind: 'tool', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
		state: 'running', revision: 1, startedAt: '2026-10-13T00:00:00.000Z', links: [],
		attributes: { nested: { text: 'token=private' }, big: 'content'.repeat(1_000) },
		events: Array.from({ length: 5 }, () => ({ name: 'event', at: '2026-10-13T00:00:00.000Z', attributes: { password: 'secret' } })),
		capture: emptyReport(settings),
	};
	const snapshot = prepareSnapshot(input, settings);
	assert.ok(TraceSpanSchema.safeParse(snapshot).success);
	assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 2_048);
	assert.ok(snapshot.capture.droppedEvents >= 3);
	assert.ok(!JSON.stringify(snapshot).includes('private'));
	assert.ok(Object.isFrozen(snapshot.attributes.nested));
	input.events.length = 0;
	assert.equal(snapshot.events.length, 2);
	assert.throws(() => { snapshot.attributes.changed = true; });
});

test('provider usage reuses normalization and preserves partial, absent, and zero counts', () => {
	assert.deepEqual(providerUsage('openai', { id: 'response', usage: { input_tokens: 0 } }), { source: 'provider-reported', provider: 'openai', requestId: 'response', inputTokens: 0 });
	assert.deepEqual(providerUsage('anthropic', { usage: { output_tokens: 5 } }), { source: 'provider-reported', provider: 'anthropic', outputTokens: 5 });
	assert.equal(providerUsage('openai', { usage: {} }), undefined);
	assert.equal(providerUsage('openai', { usage: { input_tokens: -1 } }), undefined);
	assert.equal(providerUsage('openai', { usage: { total_tokens: Number.MAX_SAFE_INTEGER + 1 } }), undefined);
	const response = Object.freeze({ id: 'response', model: 'model', usage: Object.freeze({ input_tokens: 4, output_tokens: 3 }) });
	assert.deepEqual(providerUsage('openai', response), { source: 'computed-from-provider-fields', provider: 'openai', model: 'model', requestId: 'response', inputTokens: 4, outputTokens: 3, totalTokens: 7 });
	assert.deepEqual(providerUsage('auto', { count: 2 }, { provider: 'custom', inputTokens: 'count' }), { source: 'provider-reported', provider: 'custom', inputTokens: 2 });
});