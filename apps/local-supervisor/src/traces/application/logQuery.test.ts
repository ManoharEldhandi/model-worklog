import assert from 'node:assert/strict';
import test from 'node:test';

import { LogQueryRequestSchema, type LogQueryEvidence } from 'model-worklog-schema';

import type { LogQueryRepository } from '../domain/logQuery';
import { LogQueryService } from './logQuery';

const source: LogQueryEvidence = {
	id: 'S1', projectId: 'project', traceId: '1'.repeat(32), spanId: '1'.repeat(16), sequence: 1, revision: 1,
	name: 'validation', serviceName: 'test', kind: 'tool', state: 'failed', startedAt: '2026-10-20T00:00:00.000Z', excerpt: 'Quantity cannot be negative.',
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
