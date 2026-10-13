import assert from 'node:assert/strict';
import test from 'node:test';

import { TraceSpanSchema, type TraceSpan } from 'model-worklog-schema';

import { sanitizeSpan } from './privacy';
import { summarizeTrace } from './summary';

function span(overrides: Partial<TraceSpan> = {}): TraceSpan {
	return TraceSpanSchema.parse({
		schemaVersion: 1, projectId: 'project', traceId: '1'.repeat(32), spanId: '1'.repeat(16),
		name: 'root', serviceName: 'test', kind: 'agent', state: 'completed', revision: 1,
		startedAt: '2026-10-13T00:00:00.000Z', endedAt: '2026-10-13T00:00:01.000Z',
		attributes: {}, events: [], links: [],
		capture: { mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] },
		...overrides,
	});
}

test('collector privacy overrides sender and redacts all label surfaces', () => {
	const secret = `sk-${'s'.repeat(24)}`;
	const input = span({
		name: secret, serviceName: secret,
		attributes: { prompt: 'private content', 'gen_ai.request.model': secret, reasoning: 'hidden' },
		events: [{ name: secret, at: '2026-10-13T00:00:00.000Z', attributes: { prompt: 'private content' } }],
		usage: { source: 'provider-reported', provider: secret, model: secret, requestId: secret, totalTokens: 0 },
		capture: { mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [secret] },
	});
	const clean = sanitizeSpan(input, {});
	assert.equal(clean.capture.mode, 'metadata');
	assert.equal(clean.name, '[REDACTED]');
	assert.equal(clean.usage?.requestId, '[REDACTED]');
	assert.ok(!JSON.stringify(clean).includes(secret));
	assert.ok(!JSON.stringify(clean).includes('private content'));
	assert.ok(clean.capture.redactedFields >= 10);
	const allowed = sanitizeSpan(input, { mode: 'redacted-content', excludedKeys: ['gen_ai.request.model'] });
	assert.equal(allowed.attributes.prompt, 'private content');
	assert.equal(allowed.attributes.reasoning, undefined);
	assert.equal(allowed.attributes['gen_ai.request.model'], undefined);
	assert.equal(sanitizeSpan({ ...input, capture: { ...input.capture, mode: 'metadata' } }, { mode: 'redacted-content' }).attributes.prompt, undefined);
});

test('summaries count only final model requests and preserve unknown versus zero', () => {
	const root = span({ usage: { source: 'adapter-reported', totalTokens: 900 } });
	const model = span({ spanId: '2'.repeat(16), parentSpanId: root.spanId, kind: 'model', usage: { source: 'provider-reported', totalTokens: 0 } });
	const duplicate = { ...model, spanId: '3'.repeat(16), usageKey: 'provider:request' };
	const summary = summarizeTrace(root.projectId, root.traceId, [root, { ...model, usageKey: 'provider:request' }, duplicate], root.endedAt!);
	assert.equal(summary.totalTokens, 0);
	assert.equal(summary.incomplete, false);
	assert.equal(summarizeTrace(root.projectId, root.traceId, [root], root.endedAt!).totalTokens, undefined);
	const unknown = { ...model, spanId: '4'.repeat(16), usage: undefined };
	const partial = summarizeTrace(root.projectId, root.traceId, [root, model, unknown], root.endedAt!);
	assert.equal(partial.totalTokens, 0);
	assert.equal(partial.incomplete, true);
	const open = { ...model, state: 'running' as const, endedAt: undefined };
	assert.equal(summarizeTrace(root.projectId, root.traceId, [root, open], root.endedAt!).totalTokens, undefined);
});

test('orphan, open descendant, cycle and capture loss summaries remain incomplete', () => {
	const root = span();
	const child = span({ spanId: '2'.repeat(16), parentSpanId: root.spanId, name: 'child' });
	assert.equal(summarizeTrace(root.projectId, root.traceId, [child], root.endedAt!).incomplete, true);
	const resolved = summarizeTrace(root.projectId, root.traceId, [child, root], root.endedAt!);
	assert.equal(resolved.name, 'root');
	assert.equal(resolved.incomplete, false);
	const running = summarizeTrace(root.projectId, root.traceId, [root, { ...child, state: 'running' }], root.endedAt!);
	assert.equal(running.state, 'running');
	assert.equal(running.incomplete, true);
	assert.equal(summarizeTrace(root.projectId, root.traceId, [root, { ...child, capture: { ...child.capture, droppedEvents: 1 } }], root.endedAt!).incomplete, true);
	assert.equal(summarizeTrace(root.projectId, root.traceId, [{ ...root, parentSpanId: child.spanId }, child], root.endedAt!).incomplete, true);
});