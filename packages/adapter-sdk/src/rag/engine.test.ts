import assert from 'node:assert/strict';
import test from 'node:test';
import type { StoredTraceSpan } from 'model-worklog-schema';
import { LogRag } from './engine';
import type { LogRagChunk, LogRagEmbedder, LogRagScope, LogRagVectorStore } from './types';

function span(id: number, output: string, projectId = 'app', revision = 1): StoredTraceSpan {
	return { span: { schemaVersion: 1, projectId, traceId: '1'.repeat(32), spanId: id.toString(16).padStart(16, '0'), revision, name: 'operation', serviceName: 'test', kind: 'tool', state: 'completed', startedAt: '2026-10-13T00:00:00Z', endedAt: '2026-10-13T00:00:01Z', attributes: { output }, events: [], links: [], capture: { mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] } }, receivedAt: '2026-10-13T00:00:01Z', sequence: id, evidenceGrade: 'model-declared' };
}
class Store implements LogRagVectorStore {
	rows = new Map<string, { chunk: LogRagChunk; vector: readonly number[] }>();
	async initialize(): Promise<void> {}
	private eligible(scope: LogRagScope): { chunk: LogRagChunk; vector: readonly number[] }[] { return [...this.rows.values()].filter(({ chunk }) => chunk.source.projectId === scope.projectId && (scope.traceId === undefined || scope.traceId === chunk.source.traceId) && (scope.spanId === undefined || scope.spanId === chunk.source.spanId)); }
	async list(scope: LogRagScope, limit: number): Promise<{ chunks: LogRagChunk[]; hasMore: boolean }> { const rows = this.eligible(scope); return { chunks: rows.slice(0, limit).map((row) => row.chunk), hasMore: rows.length > limit }; }
	async upsert(chunks: readonly LogRagChunk[], vectors: readonly (readonly number[])[]): Promise<void> { chunks.forEach((chunk, index) => this.rows.set(chunk.id, { chunk, vector: vectors[index]! })); }
	async query(scope: LogRagScope, vector: readonly number[], limit: number): Promise<{ id: string; similarity: number }[]> { return this.eligible(scope).map((row) => ({ id: row.chunk.id, similarity: row.vector.reduce((sum, value, index) => sum + value * vector[index]!, 0) })).sort((a, b) => b.similarity - a.similarity).slice(0, limit); }
	async delete(scope: LogRagScope, _signal: AbortSignal, olderThanRevision?: number): Promise<void> { for (const row of this.eligible(scope)) { if (olderThanRevision === undefined || row.chunk.source.revision < olderThanRevision) { this.rows.delete(row.chunk.id); } } }
}
const embedding = (text: string): number[] => /refund|money back/i.test(text) ? [1, 0, 0] : /pool|connection/i.test(text) ? [0, 1, 0] : [0, 0, 1];

test('SDK hybrid retrieval finds paraphrases, filters projects, and supports revision-safe deletion', async () => {
	const store = new Store(); let batches = 0;
	const embedder: LogRagEmbedder = { id: 'test-v1', model: 'test', embed: async (texts) => { batches += 1; return texts.map(embedding); } };
	const rag = new LogRag({ store, embedder });
	await rag.indexSpans([span(1, 'The refund was rejected by the payment provider.'), span(2, 'The connection pool is full.'), span(3, 'Private refund details', 'other')]);
	const calls = batches; await rag.indexSpans([span(1, 'The refund was rejected by the payment provider.')]); assert.equal(batches, calls);
	let result = await rag.search({ projectId: 'app', question: 'Why could the customer not get their money back?', limit: 1 });
	assert.equal(result.hits[0]?.chunk.source.spanId, '1'.padStart(16, '0'));
	assert.ok(result.hits.every((hit) => hit.chunk.source.projectId === 'app'));
	await rag.indexSpans([span(1, 'The refund succeeded.', 'app', 2)]);
	await rag.indexSpans([span(1, 'An obsolete refund failure.')]);
	result = await rag.search({ projectId: 'app', question: 'refund', limit: 1 });
	assert.equal(result.hits[0]?.chunk.source.revision, 2);
	assert.doesNotMatch(JSON.stringify(result), /refund was rejected|obsolete/);
	await assert.rejects(rag.indexSpans([span(1, 'Conflicting same revision.', 'app', 2)]), /revision/i);
	await rag.delete({ projectId: 'app', traceId: '1'.repeat(32) });
	assert.equal((await rag.search({ projectId: 'app', question: 'refund' })).hits.length, 0);
});

test('query embedding failures disclose BM25 fallback and invalid answer citations fall back to excerpts', async () => {
	let fail = false;
	const rag = new LogRag({ store: new Store(), embedder: { id: 'test', model: 'test', embed: async (texts) => texts.map(embedding), embedQuery: async (text) => { if (fail) { throw new Error('secret-provider-error'); } return embedding(text); } },
		answerer: { answer: async () => ({ answer: 'Invented source [S999].', sourceIds: ['S999'] }) } });
	await rag.indexSpans([span(1, 'Refund rejected.')]); fail = true;
	const answer = await rag.ask({ projectId: 'app', question: 'refund' });
	assert.equal(answer.mode, 'bm25'); assert.equal(answer.degraded, true); assert.equal(answer.generation, 'fallback');
	assert.match(answer.answer, /Refund rejected/);
	assert.doesNotMatch(JSON.stringify(answer), /secret-provider-error|Invented source/);
});

test('reranker failures explicitly mark retrieval degraded and retain the original sources', async () => {
	const rag = new LogRag({ store: new Store(), embedder: { id: 'test', model: 'test', embed: async (texts) => texts.map(embedding) },
		reranker: { rerank: async () => { throw new Error('private-provider-detail'); } } });
	await rag.indexSpans([span(1, 'Refund rejected.')]);
	const result = await rag.search({ projectId: 'app', question: 'refund' });
	assert.equal(result.degraded, true);
	assert.equal(result.hits.length, 1);
	assert.ok(result.limitations.some((item) => item.includes('reranker')));
	assert.doesNotMatch(JSON.stringify(result), /private-provider-detail/);
});

test('cancellation and strict query bounds are enforced before plugins receive data', async () => {
	const rag = new LogRag({ store: new Store(), embedder: { id: 'test', model: 'test', embed: async (texts) => texts.map(embedding) } });
	const signal = AbortSignal.abort();
	await assert.rejects(rag.search({ projectId: 'app', question: 'refund', signal }), { name: 'AbortError' });
	await assert.rejects(rag.search({ projectId: '*', question: 'refund' }));
	await assert.rejects(rag.search({ projectId: 'app', question: '', limit: 100 }));
});

test('a scored reranker can reject irrelevant nearest neighbours instead of inventing an answer', async () => {
	const rag = new LogRag({ store: new Store(), embedder: { id: 'test', model: 'test', embed: async (texts) => texts.map(() => [1, 0]) }, minRerankScore: .05,
		reranker: { rerank: async (_question, hits) => hits.map((hit) => ({ id: hit.id, score: .001 })) } });
	await rag.indexSpans([span(1, 'Refund rejected.')]);
	const answer = await rag.ask({ projectId: 'app', question: 'Who won the football final?' });
	assert.equal(answer.hits.length, 0);
	assert.match(answer.answer, /No relevant indexed evidence/);
});

test('failure questions use retained failure states to separate successful negative controls', async () => {
	const failed = span(1, 'The request failed.'); failed.span.state = 'failed';
	const healthy = span(2, 'The request succeeded with no failed calls.');
	const rag = new LogRag({ store: new Store(), embedder: { id: 'test', model: 'test', embed: async (texts) => texts.map(() => [1, 0]) },
		reranker: { rerank: async (_question, hits) => hits.map((hit) => ({ id: hit.id, score: hit.chunk.source.state === 'failed' ? .90 : .95 })) } });
	await rag.indexSpans([healthy, failed]);
	assert.equal((await rag.search({ projectId: 'app', question: 'Which request failed?', limit: 1 })).hits[0]?.chunk.source.state, 'failed');
});

test('an explicit semantic recall floor preserves strong evidence rejected by a weak reranker', async () => {
	const rag = new LogRag({ store: new Store(), embedder: { id: 'test', model: 'test', embed: async (texts) => texts.map(() => [1, 0]) }, minRerankScore: .05, rerankRecallFloor: .8,
		reranker: { rerank: async (_question, hits) => hits.map((hit) => ({ id: hit.id, score: .00000001 })) } });
	await rag.indexSpans([span(1, 'Refund window expired.')]);
	assert.equal((await rag.search({ projectId: 'app', question: 'refund' })).hits.length > 0, true);
});

test('retention sync never prunes an incomplete source or index and rejects foreign records', async () => {
	const store = new Store();
	const rag = new LogRag({ store, embedder: { id: 'test', model: 'test', embed: async (texts) => texts.map(embedding) } });
	await rag.indexSpans([span(1, 'refund'), span(2, 'pool'), span(3, 'private', 'other')]);
	await assert.rejects(rag.sync({ load: async () => ({ spans: [span(1, 'refund')], complete: false, limitations: ['Page limit.'] }) }, { projectId: 'app' }, { prune: true }), /incomplete source/);
	assert.equal((await rag.search({ projectId: 'app', question: 'pool' })).aggregates.spans, 2);
	const partial = new LogRag({ store, maxCorpusChunks: 1, embedder: { id: 'test', model: 'test', embed: async (texts) => texts.map(embedding) } });
	await assert.rejects(partial.sync({ load: async () => ({ spans: [], complete: true, limitations: [] }) }, { projectId: 'app' }, { prune: true }), /incomplete index/);
	await assert.rejects(rag.sync({ load: async () => ({ spans: [span(4, 'foreign', 'other')], complete: true, limitations: [] }) }, { projectId: 'app' }, { prune: true }), /outside/);
	await rag.sync({ load: async () => ({ spans: [span(1, 'refund')], complete: true, limitations: [] }) }, { projectId: 'app' }, { prune: true });
	assert.equal((await rag.search({ projectId: 'app', question: 'refund' })).aggregates.spans, 1);
	assert.equal((await rag.search({ projectId: 'other', question: 'private' })).aggregates.spans, 1);
});

test('cancellation bounds custom plugins that ignore the abort signal', async () => {
	const store = new Store();
	const rag = new LogRag({ store, embedder: { id: 'test', model: 'test', embed: async (texts) => texts.map(embedding), embedQuery: async () => new Promise(() => {}) } });
	await rag.indexSpans([span(1, 'refund')]);
	const controller = new AbortController();
	const pending = rag.search({ projectId: 'app', question: 'refund', signal: controller.signal });
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(pending, { name: 'AbortError' });
});
