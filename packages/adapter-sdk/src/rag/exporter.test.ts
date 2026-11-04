import assert from 'node:assert/strict';
import test from 'node:test';
import { LogRagTraceExporter } from './exporter';
import { TraceExportError } from '../tracing/exporter';

test('RAG exporter connects normal SDK batches to indexing and preserves delivery failures', async () => {
	let indexed = 0;
	const exporter = new LogRagTraceExporter({ indexSpans: async (spans) => { indexed += spans.length; return { indexedSpans: spans.length, skippedSpans: 0 }; } });
	const batch = { schemaVersion: 1 as const, spans: [{ schemaVersion: 1 as const, projectId: 'app', traceId: '1'.repeat(32), spanId: '1'.repeat(16), revision: 1, name: 'tool', kind: 'tool' as const, state: 'completed' as const, serviceName: 'test', startedAt: '2026-10-13T00:00:00Z', endedAt: '2026-10-13T00:00:01Z', attributes: {}, events: [], links: [], capture: { mode: 'metadata' as const, redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] } }] };
	assert.deepEqual(await exporter.export(batch), { schemaVersion: 1, accepted: 1, duplicates: 0 });
	assert.equal(indexed, 1);
	const grouped = new LogRagTraceExporter({ indexSpans: async () => ({ indexedSpans: 1, skippedSpans: 0 }) });
	assert.deepEqual(await grouped.export({ ...batch, spans: [batch.spans[0]!, { ...batch.spans[0]!, revision: 2 }] }), { schemaVersion: 1, accepted: 1, duplicates: 1 });
	const failed = new LogRagTraceExporter({ indexSpans: async () => { throw new Error('private-backend-error'); } });
	await assert.rejects(failed.export(batch), (error: unknown) => error instanceof TraceExportError && error.retryable && !error.message.includes('private-backend-error'));
});
