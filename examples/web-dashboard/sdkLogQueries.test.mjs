import assert from 'node:assert/strict';
import test from 'node:test';
import { LogQueryRequestSchema, LogQueryResponseSchema } from 'model-worklog-schema';
import { createSdkLogQuery } from './sdkLogQueries.mjs';

const source = { projectId: 'web-demo', traceId: '1'.repeat(32), spanId: '2'.repeat(16), revision: 1, name: 'payment.refund', kind: 'tool', state: 'failed', startedAt: '2026-11-04T10:00:00Z', capture: { mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] }, evidenceGrade: 'model-declared' };
const base = LogQueryResponseSchema.parse({ schemaVersion: 1, intent: 'search', answer: 'Old keyword answer.', scope: { projectId: 'web-demo' }, snapshotAt: source.startedAt,
	totals: { spans: 1, traces: 1, toolCalls: 1, failedSpans: 1, runningSpans: 0, metadataOnlySpans: 0, limitedSpans: 0 }, tools: [], evidence: [], retrieval: { strategy: 'sqlite-scan', matchedSpans: 0, returnedSpans: 0, truncated: false, toolsTruncated: false }, limitations: [] });
const hit = { id: 'S1', chunk: { id: 'a'.repeat(64), text: 'payment.refund | tool | worker\noutput: {"message":"Refund rejected because the payment was settled 190 days ago; refunds are allowed within 180 days."}', source, shortened: false } };
function setup(generator) {
	let searches = 0; let synchronized = 0;
	const query = createSdkLogQuery({ client: { askLogs: async () => base }, generator, rag: {
		async sync(_source, scope) { assert.equal(scope.projectId, 'web-demo'); synchronized++; return { complete: true, limitations: [] }; },
		async search(request) { searches++; assert.equal(request.mode, 'hybrid'); return { hits: [hit], mode: 'hybrid', degraded: false, coverage: { indexedSpans: 1, indexedChunks: 3, truncated: false }, limitations: [] }; },
	} });
	return { query, counts: () => ({ searches, synchronized }) };
}

test('browser answers use SDK hybrid evidence and retain exact collector counts and citations', async () => {
	const { query, counts } = setup({ provider: 'test', async generate(question, evidence) {
		assert.equal(evidence.retrieval.strategy, 'chroma-hybrid'); assert.match(evidence.evidence[0].excerpt, /180/);
		return { answer: 'The payment was 190 days old, beyond the 180-day refund window. [S1]', sourceIds: ['S1'] };
	} });
	const answer = await query(LogQueryRequestSchema.parse({ projectId: 'web-demo', question: 'Why did the refund fail?', synthesis: 'model' }), AbortSignal.timeout(2000));
	assert.match(answer.answer, /beyond the 180-day/); assert.equal(answer.generation.status, 'generated');
	assert.equal(answer.totals.toolCalls, 1); assert.equal(answer.retrieval.semantic.indexedChunks, 3); assert.deepEqual(counts(), { searches: 1, synchronized: 1 });
	assert.ok(LogQueryResponseSchema.safeParse(answer).success);
});

test('missing fields and provider failures produce clear answers rather than a raw record dump', async () => {
	const { query } = setup({ async generate() { return { answer: 'Invented amount [S999]', sourceIds: ['S999'] }; } });
	const answer = await query(LogQueryRequestSchema.parse({ projectId: 'web-demo', question: 'What is the amount?', synthesis: 'model' }), AbortSignal.timeout(2000));
	assert.match(answer.answer, /amount.*(?:not captured|not recorded|wasn't recorded)/i);
	assert.doesNotMatch(answer.answer, /attributes:|output:|190|Invented/); assert.equal(answer.generation.status, 'fallback');
});

test('stopping a semantic answer cancels even an answer provider that ignores the signal', async () => {
	let start; const started = new Promise((resolve) => { start = resolve; });
	const { query } = setup({ generate() { start(); return new Promise(() => {}); } });
	const controller = new AbortController();
	const pending = query(LogQueryRequestSchema.parse({ projectId: 'web-demo', question: 'What happened?', synthesis: 'model' }), controller.signal);
	await started; controller.abort();
	await assert.rejects(pending, { name: 'AbortError' });
});

test('exact counts bypass semantic services and model startup without changing their scope', async () => {
	const counts = { ...base, intent: 'tools', answer: 'read_file was called 12 times. [A1]' };
	const query = createSdkLogQuery({ client: { async askLogs(request) { assert.equal(request.scope, undefined); return counts; } }, rag: { sync() { throw new Error('Counts must not index'); } }, generator: { generate() { throw new Error('Counts must not call a model'); } } });
	const answer = await query(LogQueryRequestSchema.parse({ projectId: 'web-demo', question: 'How many times was read_file used?', synthesis: 'model' }));
	assert.equal(answer.answer, counts.answer); assert.deepEqual(answer.scope, counts.scope);
});

test('captures can prepare their index before a question while each question still synchronizes its scope', async () => {
	const { query, counts } = setup();
	await query.prepare({ projectId: 'web-demo' }, AbortSignal.timeout(2000));
	assert.deepEqual(counts(), { synchronized: 1, searches: 0 });
	await query(LogQueryRequestSchema.parse({ projectId: 'web-demo', question: 'Why did it fail?' }));
	assert.deepEqual(counts(), { synchronized: 2, searches: 1 });
	const controller = new AbortController(); controller.abort();
	assert.throws(() => query.prepare({ projectId: 'web-demo' }, controller.signal), { name: 'AbortError' });
});
