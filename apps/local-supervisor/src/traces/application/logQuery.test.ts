import assert from 'node:assert/strict';
import test from 'node:test';

import { LogQueryRequestSchema, type LogQueryEvidence } from 'model-worklog-schema';

import type { LogQueryRepository } from '../domain/logQuery';
import { LogQueryService } from './logQuery';

const source: LogQueryEvidence = {
	id: 'S1', projectId: 'project', traceId: '1'.repeat(32), spanId: '1'.repeat(16), sequence: 1, revision: 1,
	name: 'validation', serviceName: 'test', kind: 'tool', state: 'failed', startedAt: '2026-10-20T00:00:00.000Z', excerpt: 'Quantity cannot be negative.', excerptTruncated: false,
	evidenceGrade: 'model-declared', capture: { mode: 'metadata', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] },
};

const repository: LogQueryRepository = { retrieve: () => ({
	totals: { spans: 1, traces: 1, toolCalls: 1, failedSpans: 1, runningSpans: 0, metadataOnlySpans: 1, limitedSpans: 0 },
	tools: [], evidence: [source], matchedSpans: 1, toolsTruncated: false, strategy: 'failed-spans',
}) };

test('query cancellation completes even when a custom generator ignores its signal', async () => {
	const service = new LogQueryService(repository, { admit: () => undefined }, () => new Date(source.startedAt), { generate: async () => new Promise(() => undefined) });
	const cancellation = new AbortController();
	const pending = service.askWithSynthesis('reader', LogQueryRequestSchema.parse({ projectId: 'project', question: 'What failed?', synthesis: 'model' }), cancellation.signal);
	cancellation.abort();
	await assert.rejects(pending, { name: 'AbortError' });
});

test('provider failure falls back without leaking errors or mutating input evidence', async () => {
	const before = JSON.stringify(source);
	const request = Object.freeze(LogQueryRequestSchema.parse({ projectId: 'project', question: 'What failed?', synthesis: 'model' }));
	const service = new LogQueryService(repository, { admit: () => undefined }, () => new Date(source.startedAt), { generate: async () => { throw new Error('token=never-leak-provider-secret'); } });
	const result = await service.askWithSynthesis('reader', request);
	assert.equal(result.generation.status, 'fallback');
	assert.match(result.answer, /Quantity cannot be negative/);
	assert.doesNotMatch(JSON.stringify(result), /never-leak-provider-secret/);
	assert.equal(JSON.stringify(source), before);
	assert.equal(request.synthesis, 'model');
});

test('AI answers tool questions conversationally using exact aggregate citations and sanitized history', async () => {
	let calls = 0;
	const service = new LogQueryService(repository, { admit: () => undefined }, () => new Date(source.startedAt), {
		provider: 'test-provider',
		async generate(question, evidence, _signal, history) {
			calls += 1;
			assert.equal(question, 'How many tool calls were there?');
			assert.equal(evidence.totals.toolCalls, 1);
			assert.doesNotMatch(JSON.stringify(history), /private-history-value/);
			return { answer: 'There was one tool call in this run, and it failed. [A1]', sourceIds: ['A1'] };
		},
	});
	const answer = await service.askWithSynthesis('reader', LogQueryRequestSchema.parse({ projectId: 'project', question: 'How many tool calls were there?', synthesis: 'model', history: [{ role: 'user', content: 'Inspect token=private-history-value' }] }));
	assert.equal(answer.generation.status, 'generated');
	assert.equal(answer.generation.provider, 'test-provider');
	assert.equal(answer.answer, 'There was one tool call in this run, and it failed. [A1]');
	assert.equal(calls, 1);
});

test('an empty scope still supports an honest conversational answer, without invented sources', async () => {
	const empty: LogQueryRepository = { retrieve: () => ({ totals: { spans: 0, traces: 0, toolCalls: 0, failedSpans: 0, runningSpans: 0, metadataOnlySpans: 0, limitedSpans: 0 }, tools: [], evidence: [], matchedSpans: 0, toolsTruncated: false, strategy: 'recent-spans' }) };
	const service = new LogQueryService(empty, { admit: () => undefined }, () => new Date(source.startedAt), { generate: async () => ({ answer: 'There are no retained records in this scope, so I cannot establish what happened.', sourceIds: [] }) });
	const answer = await service.askWithSynthesis('reader', LogQueryRequestSchema.parse({ projectId: 'project', question: 'What happened?', synthesis: 'model' }));
	assert.equal(answer.generation.status, 'generated');
	assert.match(answer.answer, /cannot establish/);
});

test('historical citations cannot be reused as evidence for a new answer', async () => {
	const service = new LogQueryService(repository, { admit: () => undefined }, () => new Date(source.startedAt), { generate: async () => ({ answer: 'A previous claim [S99].', sourceIds: ['S99'] }) });
	const answer = await service.askWithSynthesis('reader', LogQueryRequestSchema.parse({ projectId: 'project', question: 'Why did it do that?', synthesis: 'model', history: [{ role: 'assistant', content: 'A previous claim [S99].' }] }));
	assert.equal(answer.generation.status, 'fallback');
	assert.doesNotMatch(answer.answer, /previous claim/);
});
