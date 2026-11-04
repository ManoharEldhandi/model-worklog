import assert from 'node:assert/strict';
import test from 'node:test';
import { CollectorLogSource } from './collectorSource';

test('collector source rejects pagination loops and never claims complete coverage at bounds', async () => {
	const source = new CollectorLogSource({ listTraces: async () => ({ schemaVersion: 1, traces: [], nextCursor: 'repeated' }), getTraceSpans: async () => ({ schemaVersion: 1, spans: [], nextCursor: null }) });
	await assert.rejects(source.load({ projectId: 'app' }, AbortSignal.timeout(2000)), /Repeated collector cursor/);
	const unsafe = new CollectorLogSource({ listTraces: async () => ({ schemaVersion: 1, traces: [{ projectId: 'other', traceId: '1'.repeat(32), name: 'private', serviceName: 'test', state: 'completed', startedAt: '2026-10-13T00:00:00Z', updatedAt: '2026-10-13T00:00:01Z', spanCount: 0, incomplete: false }], nextCursor: null }), getTraceSpans: async () => ({ schemaVersion: 1, spans: [], nextCursor: null }) });
	await assert.rejects(unsafe.load({ projectId: 'app' }, AbortSignal.timeout(2000)), /scope mismatch/);
});
