import assert from 'node:assert/strict';
import test from 'node:test';
import { ChromaLogVectorStore } from './chroma';
import { chunkSpans } from './chunking';
import type { StoredTraceSpan } from 'model-worklog-schema';

test('Chroma adapter rejects unsafe endpoint and invalid collection options', () => {
	for (const url of ['http://remote.example:8000', 'https://user:secret@example.com', 'http://localhost:8000/?token=secret']) { assert.throws(() => new ChromaLogVectorStore({ url, collection: 'test-logs' })); }
});

test('real Chroma uses cosine HNSW, persistent scoped records, revision cleanup and deletion', { skip: process.env.MODEL_WORKLOG_TEST_CHROMA_URL === undefined }, async () => {
	const store = new ChromaLogVectorStore({ url: process.env.MODEL_WORKLOG_TEST_CHROMA_URL!, collection: `test-logs-${Date.now()}` });
	const signal = AbortSignal.timeout(30_000);
	await store.initialize({ id: 'test-embedding-v1', model: 'test' }, signal);
	const stored: StoredTraceSpan = { span: { schemaVersion: 1, projectId: 'app', traceId: '1'.repeat(32), spanId: '1'.repeat(16), revision: 1, name: 'refund', kind: 'tool', serviceName: 'test', state: 'completed', startedAt: '2026-10-13T00:00:00Z', endedAt: '2026-10-13T00:00:01Z', attributes: { output: 'Payment refund rejected.' }, events: [], links: [], capture: { mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] } }, receivedAt: '2026-10-13T00:00:01Z', sequence: 1, evidenceGrade: 'model-declared' };
	const chunks = chunkSpans([stored]);
	await store.upsert(chunks, chunks.map(() => [1, 0, 0]), signal);
	assert.equal((await store.list({ projectId: 'other' }, 100, signal)).chunks.length, 0);
	assert.equal((await store.query({ projectId: 'app' }, [1, 0, 0], 10, signal))[0]?.similarity, 1);
	const reconnect = new ChromaLogVectorStore({ url: process.env.MODEL_WORKLOG_TEST_CHROMA_URL!, collection: store.collectionName });
	await reconnect.initialize({ id: 'test-embedding-v1', model: 'test' }, signal);
	assert.equal((await reconnect.list({ projectId: 'app' }, 100, signal)).chunks.length, chunks.length);
	await assert.rejects(reconnect.initialize({ id: 'different-model', model: 'other' }, signal), /embedding/i);
	const updated = chunkSpans([{ ...stored, span: { ...stored.span, revision: 2, attributes: { output: 'Refund succeeded.' } } }]);
	await store.upsert(updated, updated.map(() => [1, 0, 0]), signal);
	await store.delete({ projectId: 'app', traceId: stored.span.traceId, spanId: stored.span.spanId }, signal, 2);
	assert.ok((await store.list({ projectId: 'app' }, 100, signal)).chunks.every((chunk) => chunk.source.revision === 2));
	await store.delete({ projectId: 'app', traceId: stored.span.traceId }, signal);
	assert.equal((await store.list({ projectId: 'app' }, 100, signal)).chunks.length, 0);
});
