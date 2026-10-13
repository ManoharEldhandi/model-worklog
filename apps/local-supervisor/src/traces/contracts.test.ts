import assert from 'node:assert/strict';
import test from 'node:test';

import { TraceBatchAckSchema, TraceDetailSchema, TraceListSchema, type TraceSpan } from 'model-worklog-schema';

import { api, credential, fixture, traceSpan } from './fixtures.test';

test('strict wire validation rejects unknown fields, invalid identifiers and forged provenance', async (context) => {
	const { supervisor } = await fixture(context);
	const original = traceSpan();
	const invalid: unknown[] = [
		{ ...original, spanId: '0'.repeat(16) }, { ...original, traceId: '0'.repeat(32) },
		{ ...original, spanId: 'ABCDEFABCDEFABCD' }, { ...original, projectId: '../other' },
		{ ...original, revision: 0 }, { ...original, revision: 1.5 }, { ...original, revision: Number.MAX_SAFE_INTEGER + 1 },
		{ ...original, evidenceGrade: 'observed-native' }, { ...original, receivedAt: original.startedAt },
		{ ...original, sequence: 1 }, { ...original, parentSpanId: original.spanId },
		{ ...original, state: 'running' }, { ...original, endedAt: undefined },
		{ ...original, usage: { source: 'provider-reported', totalTokens: 0, evidenceGrade: 'computed' } },
		{ ...original, attributes: JSON.parse('{"__proto__":{"exposed":true}}') as unknown },
		{ ...original, capture: { ...original.capture, evidenceGrade: 'observed-native' } },
	];
	for (const span of invalid) {
		assert.equal((await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [span] })).status, 400);
	}
	for (const body of [{ schemaVersion: 1, spans: [] }, { schemaVersion: 1, spans: [original], role: 'admin' }, { schemaVersion: 1, spans: Array.from({ length: 101 }, () => original) }]) {
		assert.equal((await api(supervisor, '/v2/traces/batch', undefined, 'POST', body)).status, 400);
	}
	assert.equal(TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json()).traces.length, 0);
});

test('mixed-project batches and all scoped control-plane attempts reject before writes', async (context) => {
	const { supervisor } = await fixture(context);
	const writer = await credential(supervisor, 'writer');
	const reader = await credential(supervisor, 'reader');
	const span = traceSpan();
	assert.equal((await api(supervisor, '/v2/traces/batch', writer.token, 'POST', { schemaVersion: 1, spans: [span, { ...span, projectId: 'other' }] })).status, 403);
	assert.equal(TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json()).traces.length, 0);
	for (const token of [writer.token, reader.token]) {
		assert.equal((await api(supervisor, `/v2/traces/${span.traceId}?projectId=other`, token, 'DELETE')).status, 403);
		assert.equal((await api(supervisor, '/v2/traces/retention', token, 'POST', { projectId: 'other' })).status, 403);
		assert.equal((await api(supervisor, `/v2/credentials/${reader.id}`, token, 'DELETE')).status, 403);
		assert.equal((await api(supervisor, '/v2/credentials', token, 'POST', { role: 'writer', projects: ['other'] })).status, 403);
		assert.equal((await api(supervisor, '/v1/workspaces/trust', token, 'POST', { workspacePath: '/tmp' })).status, 401);
		assert.equal((await api(supervisor, '/v1/extension-clients', token, 'POST', {})).status, 401);
	}
	for (const body of [{ role: 'admin', projects: ['project'] }, { role: 'writer', projects: ['*'] }, { role: 'reader', projects: [] }, { role: 'reader', projects: ['project'], ttlSeconds: 59 }, { role: 'reader', projects: ['project'], evidenceGrade: 'observed-native' }]) {
		assert.equal((await api(supervisor, '/v2/credentials', undefined, 'POST', body)).status, 400);
	}
	const multi = await credential(supervisor, 'writer', ['project', 'other']);
	assert.equal((await api(supervisor, '/v2/traces/batch', multi.token, 'POST', { schemaVersion: 1, spans: [span, { ...span, projectId: 'other' }] })).status, 200);
});

test('HTTP revisions are idempotent, order-independent, immutable and atomic on conflict', async (context) => {
	const { supervisor } = await fixture(context);
	const running = traceSpan({ state: 'running', endedAt: undefined, attributes: { beta: 2, alpha: 1 } });
	const send = (spans: readonly TraceSpan[]): Promise<Response> => api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans });
	assert.equal((await send([running])).status, 200);
	const completed = traceSpan({ revision: 3, attributes: { alpha: 1, beta: 2 } });
	const acknowledgement = TraceBatchAckSchema.parse(await (await send([completed, { ...running, revision: 2 }, { ...completed, attributes: { beta: 2, alpha: 1 } }])).json());
	assert.deepEqual(acknowledgement, { schemaVersion: 1, accepted: 1, duplicates: 2 });
	const other = traceSpan({ traceId: '2'.repeat(32) });
	assert.equal((await send([other, { ...completed, attributes: { alpha: 'discarded but conflicting' } }])).status, 409);
	assert.equal((await api(supervisor, `/v2/traces/${other.traceId}?projectId=project`)).status, 404);
	for (const changes of [
		{ parentSpanId: '2'.repeat(16) }, { startedAt: '2026-10-12T00:00:00.000Z' },
		{ name: 'other name' }, { serviceName: 'other service' }, { kind: 'model' as const },
		{ state: 'running' as const, endedAt: undefined },
	]) {
		assert.equal((await send([{ ...completed, revision: 4, ...changes }])).status, 409);
	}
	const saved = TraceDetailSchema.parse(await (await api(supervisor, `/v2/traces/${completed.traceId}?projectId=project`)).json());
	assert.equal(saved.spans[0]?.span.revision, 3);
	assert.equal(saved.spans[0]?.span.name, 'root');
	assert.equal(saved.spans[0]?.evidenceGrade, 'model-declared');
	assert.equal((await api(supervisor, `/v2/traces/${completed.traceId}?projectId=other`, undefined, 'DELETE')).status, 404);
	assert.equal((await api(supervisor, `/v2/traces/${completed.traceId}?projectId=project`, undefined, 'DELETE')).status, 200);
});