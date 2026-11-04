import assert from 'node:assert/strict';
import test from 'node:test';
import { bm25, reciprocalRankFusion, tokenize } from './ranking';
import { chunkSpans, normalizeVector } from './chunking';
import { LogQueryEvidenceSchema } from 'model-worklog-schema';

test('BM25 preserves full identifiers and ranks exact rare file and tool names', () => {
	assert.ok(tokenize('src/payment-service.ts read_file').includes('src/payment-service.ts'));
	const ranks = bm25('src/payment-service.ts', [{ id: 'noise', text: 'payment service payment service payment service' }, { id: 'target', text: 'Read src/payment-service.ts and fixed the refund validation.' }]);
	assert.equal(ranks[0]?.id, 'target');
});

test('RRF combines ranks rather than comparing incompatible vector/BM25 scores', () => {
	const fused = reciprocalRankFusion([{ id: 'a', score: 99999 }, { id: 'b', score: 2 }], [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.8 }], 60);
	assert.equal(fused[0]?.id, 'b');
	assert.ok(Math.abs(fused[0]!.score - (1 / 62 + 1 / 61)) < 1e-12);
	assert.deepEqual(reciprocalRankFusion([], [], 60), []);
});

test('embedding normalization rejects malformed and zero vectors', () => {
	assert.deepEqual(normalizeVector([3, 4]), [0.6, 0.8]);
	for (const values of [[], [0, 0], [NaN], [Infinity], Array(4097).fill(1)]) { assert.throws(() => normalizeVector(values)); }
});

test('chunking redacts secrets, excludes hidden content, and retains result/events before long input', () => {
	const chunks = chunkSpans([{ span: { schemaVersion: 1, projectId: 'app', traceId: '1'.repeat(32), spanId: '1'.repeat(16), revision: 1, name: 'refund', serviceName: 'agent', kind: 'tool', state: 'failed', startedAt: '2026-10-13T00:00:00Z', endedAt: '2026-10-13T00:00:01Z',
		attributes: { input: 'x'.repeat(16000), output: 'Refund rejected. token=private-secret', reasoning: 'hidden-private-content' }, events: [{ name: 'exception', at: '2026-10-13T00:00:00Z', attributes: { message: 'Payment gateway unavailable.' } }], links: [], capture: { mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] } }, receivedAt: '2026-10-13T00:00:01Z', sequence: 1, evidenceGrade: 'model-declared' }]);
	assert.ok(chunks.length <= 8);
	assert.ok(chunks.every((chunk) => chunk.text.length <= 1800));
	assert.ok(chunks.some((chunk) => chunk.text.includes('Refund rejected')));
	assert.ok(chunks.some((chunk) => chunk.text.includes('gateway unavailable')));
	assert.doesNotMatch(JSON.stringify(chunks), /private-secret|hidden-private-content/);
	assert.ok(chunks.every((chunk) => chunk.shortened));
});

test('redacted source labels remain within persisted evidence bounds', () => {
	const [chunk] = chunkSpans([{ span: { schemaVersion: 1, projectId: 'app', traceId: '1'.repeat(32), spanId: '1'.repeat(16), revision: 1,
		name: 'token=x '.repeat(32), serviceName: 'agent', kind: 'tool', state: 'completed', startedAt: '2026-10-13T00:00:00Z', endedAt: '2026-10-13T00:00:01Z',
		attributes: { 'tool.name': 'long-tool-'.repeat(100) }, events: [], links: [], usage: { source: 'provider-reported', totalTokens: 1, provider: 'token=x '.repeat(16) },
		capture: { mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: ['token=x '.repeat(32)] } },
		receivedAt: '2026-10-13T00:00:01Z', sequence: 1, evidenceGrade: 'model-declared' }]);
	assert.ok(chunk);
	assert.ok(chunk.source.toolName!.length <= 256);
	const { toolName: _toolName, ...source } = chunk.source;
	assert.ok(LogQueryEvidenceSchema.safeParse({ ...source, id: 'S1', sequence: 1, serviceName: 'agent', excerpt: chunk.text }).success);
	assert.doesNotMatch(JSON.stringify(chunk), /token=x/);
});
