import assert from 'node:assert/strict';
import test from 'node:test';

import { TraceListSchema } from 'model-worklog-schema';

import { api, fixture, traceSpan } from './fixtures.test';

test('HTTP quota errors are explicit and admin cleanup cannot evict active descendants', async (context) => {
	let clock = Date.parse('2026-10-13T00:00:00.000Z');
	const { supervisor } = await fixture(context, { now: () => new Date(clock), traceStorage: { maxStoredSpans: 2 } });
	const root = traceSpan();
	const child = traceSpan({ spanId: '2'.repeat(16), parentSpanId: root.spanId, state: 'running', endedAt: undefined });
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [root, child] });
	const rejected = await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [traceSpan({ traceId: '2'.repeat(32) })] });
	assert.equal(rejected.status, 507);
	assert.equal((await rejected.json() as { error: { code: string } }).error.code, 'storage_quota');
	clock += 60_000;
	const cleanup = await api(supervisor, '/v2/traces/retention', undefined, 'POST', { projectId: 'project', before: new Date(clock).toISOString() });
	assert.deepEqual(await cleanup.json(), { schemaVersion: 1, deleted: 0, hasMore: false });
	assert.equal((await api(supervisor, `/v2/traces/${root.traceId}?projectId=project`, undefined, 'DELETE')).status, 409);
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [{ ...child, revision: 2, state: 'completed', endedAt: root.endedAt }] });
	clock += 1_000;
	assert.deepEqual(await (await api(supervisor, '/v2/traces/retention', undefined, 'POST', { projectId: 'project', before: new Date(clock).toISOString() })).json(), { schemaVersion: 1, deleted: 1, hasMore: false });
	assert.equal((await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [root] })).status, 200);
});

test('per-trace and stored-byte limits reject an entire batch without partial persistence', async (context) => {
	const { supervisor } = await fixture(context, { traceStorage: { maxSpansPerTrace: 1 } });
	const root = traceSpan();
	const child = traceSpan({ spanId: '2'.repeat(16), parentSpanId: root.spanId });
	const response = await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [root, child] });
	assert.equal(response.status, 429);
	assert.equal((await response.json() as { error: { code: string } }).error.code, 'trace_quota');
	assert.equal(TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json()).traces.length, 0);
	const { supervisor: small } = await fixture(context, { traceStorage: { maxStoredBytes: 1_024 } });
	const large = await api(small, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [traceSpan({ attributes: { 'code.function': 'x'.repeat(4_000) } })] });
	assert.equal(large.status, 507);
	assert.equal(TraceListSchema.parse(await (await api(small, '/v2/traces?projectId=project')).json()).traces.length, 0);
});

test('optional TTL expires only settled traces and admin retention is bounded and project-specific', async (context) => {
	let clock = Date.parse('2026-10-13T00:00:00.000Z');
	const { supervisor } = await fixture(context, { now: () => new Date(clock), traceStorage: { retentionTtlSeconds: 60 } });
	const old = traceSpan();
	const orphan = traceSpan({ traceId: '2'.repeat(32), parentSpanId: '2'.repeat(16) });
	const other = traceSpan({ projectId: 'other' });
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [old, orphan, other] });
	clock += 61_000;
	const newest = traceSpan({ traceId: '3'.repeat(32) });
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [newest] });
	const list = TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json());
	assert.deepEqual(list.traces.map((trace) => trace.traceId).sort(), [orphan.traceId, newest.traceId]);
	assert.equal(TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=other')).json()).traces.length, 1);
	assert.deepEqual(await (await api(supervisor, '/v2/traces/retention', undefined, 'POST', { projectId: 'other' })).json(), { schemaVersion: 1, deleted: 1, hasMore: false });
	const settled = Array.from({ length: 5 }, (_, index) => traceSpan({ traceId: (index + 10).toString(16).padStart(32, '0') }));
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: settled });
	clock += 61_000;
	const cleaned = await api(supervisor, '/v2/traces/retention', undefined, 'POST', { projectId: 'project', limit: 2 });
	assert.deepEqual(await cleaned.json(), { schemaVersion: 1, deleted: 2, hasMore: true });
	assert.equal((await api(supervisor, '/v2/traces/retention', undefined, 'POST', { projectId: 'project', limit: 101 })).status, 400);
	assert.equal((await api(supervisor, '/v2/traces/retention', undefined, 'POST', { projectId: 'project', extra: true })).status, 400);
});

test('retention timestamps use chronological equality and the cleanup body remains strict', async (context) => {
	const now = (): Date => new Date('2026-10-13T00:00:00.000Z');
	const { supervisor } = await fixture(context, { now });
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [traceSpan()] });
	const response = await api(supervisor, '/v2/traces/retention', undefined, 'POST', { projectId: 'project', before: '2026-10-13T00:00:00Z' });
	assert.deepEqual(await response.json(), { schemaVersion: 1, deleted: 0, hasMore: false });
	for (const body of [
		{ projectId: 'project' }, { projectId: 'project', before: null },
		{ projectId: 'project', before: now().toISOString(), limit: '2' },
		{ projectId: 'project', before: '2027-01-01T00:00:00.000Z' },
	]) { assert.equal((await api(supervisor, '/v2/traces/retention', undefined, 'POST', body)).status, 400); }
});