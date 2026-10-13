import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TraceBatch, TraceSpan } from 'model-worklog-schema';

import type { TraceDiagnostic } from './diagnostics';
import { TraceExportError } from './exporter';
import { TraceProcessor } from './processor';

function snapshot(revision = 1): TraceSpan {
	return {
		schemaVersion: 1, projectId: 'test', serviceName: 'sdk', name: 'span', kind: 'tool', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
		state: 'running', revision, startedAt: '2026-10-13T00:00:00.000Z', links: [], attributes: {}, events: [],
		capture: { mode: 'metadata', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] },
	};
}

test('bounded queue drops newest snapshots and reports cumulative loss even after successful flush', async () => {
	const diagnostics: TraceDiagnostic[] = [];
	const batches: TraceBatch[] = [];
	const processor = new TraceProcessor({
		maxQueueSize: 2, maxBatchSize: 2, flushIntervalMs: 0, onDiagnostic: (event) => { diagnostics.push(event); },
		exporter: { export: async (batch) => { batches.push(batch); return { schemaVersion: 1, accepted: batch.spans.length, duplicates: 0 }; } },
	});
	assert.equal(processor.enqueue(snapshot(1)), true);
	assert.equal(processor.enqueue(snapshot(2)), true);
	assert.equal(processor.enqueue(snapshot(3)), false);
	const result = await processor.flush();
	assert.equal(result.success, false);
	assert.equal(result.dropped, 1);
	assert.equal(result.pending, 0);
	assert.equal(result.lossRisk, true);
	assert.deepEqual(batches[0]?.spans.map((span) => span.revision), [1, 2]);
	assert.equal(diagnostics[0]?.code, 'queue_full');
	await processor.shutdown();
});

test('retryable failures retry a stable frozen batch, stop at the limit, and retain pending snapshots', async () => {
	const batches: TraceBatch[] = [];
	let failing = true;
	const processor = new TraceProcessor({
		maxRetries: 2, retryDelayMs: 0, flushIntervalMs: 0, onDiagnostic: () => undefined,
		exporter: { export: async (batch) => {
			batches.push(batch);
			assert.ok(Object.isFrozen(batch.spans[0]?.attributes));
			if (failing) { throw new TraceExportError('http', true, 503); }
			return { schemaVersion: 1, accepted: 0, duplicates: batch.spans.length };
		} },
	});
	processor.enqueue(snapshot());
	const failed = await processor.flush();
	assert.equal(batches.length, 3);
	assert.equal(batches[0], batches[2]);
	assert.equal(failed.pending, 1);
	assert.equal(failed.failed, 1);
	assert.equal(failed.retries, 2);
	assert.equal(failed.lossRisk, true);
	failing = false;
	const recovered = await processor.flush();
	assert.equal(recovered.success, true);
	assert.equal(recovered.duplicates, 1);
	await processor.shutdown();
});

test('flushes are serialized and exporter or diagnostic errors cannot escape', async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let active = 0;
	let maximum = 0;
	const processor = new TraceProcessor({
		flushIntervalMs: 0, maxBatchSize: 1, onDiagnostic: async () => { throw new Error('handler-secret'); },
		exporter: { export: async (batch) => {
			active += 1; maximum = Math.max(maximum, active);
			await gate;
			active -= 1;
			return { schemaVersion: 1, accepted: batch.spans.length, duplicates: 0 };
		} },
	});
	processor.enqueue(snapshot());
	const first = processor.flush();
	processor.enqueue(snapshot(2));
	const second = processor.flush();
	release?.();
	await Promise.all([first, second]);
	assert.equal(maximum, 1);
	assert.equal((await processor.shutdown()).accepted, 2);
	assert.equal(processor.enqueue(snapshot(3)), false);
	await Promise.resolve();
	assert.equal((await processor.flush()).diagnosticFailures, 1);
});

test('nonretryable errors and hung exporters return a real failed flush without unbounded retries', async () => {
	for (const hang of [false, true]) {
		let calls = 0;
		const diagnostics: TraceDiagnostic[] = [];
		const processor = new TraceProcessor({
			exportTimeoutMs: 10, flushIntervalMs: 0, onDiagnostic: (event) => { diagnostics.push(event); },
			exporter: { export: async () => {
				calls += 1;
				if (hang) { return new Promise<never>(() => undefined); }
				throw new Error('exporter-secret');
			} },
		});
		processor.enqueue(snapshot());
		const result = await processor.flush();
		assert.equal(calls, 1);
		assert.equal(result.success, false);
		assert.equal(result.pending, 1);
		assert.ok(!JSON.stringify(diagnostics).includes('secret'));
		await processor.shutdown();
		assert.equal(calls, hang ? 1 : 2);
	}
});

test('batch byte limits include the JSON envelope and malformed custom acknowledgements remain pending', async () => {
	let batches = 0;
	const processor = new TraceProcessor({
		privacy: { mode: 'redacted-content' }, limits: { maxSpanBytes: 2_048 }, maxBatchBytes: 2_200, maxBatchSize: 3,
		flushIntervalMs: 0, exporter: { export: async (batch) => {
			batches += 1;
			assert.ok(Buffer.byteLength(JSON.stringify(batch)) <= 2_200);
			return { schemaVersion: 1, accepted: batch.spans.length, duplicates: 0 };
		} },
	});
	for (const revision of [1, 2, 3]) {
		const span = snapshot(revision);
		processor.enqueue({ ...span, capture: { ...span.capture, mode: 'redacted-content' }, attributes: { content: 'x'.repeat(1_200) } });
	}
	assert.equal((await processor.shutdown()).success, true);
	assert.equal(batches, 3);
	const invalid = new TraceProcessor({ flushIntervalMs: 0, onDiagnostic: () => undefined,
		exporter: { export: async () => ({ schemaVersion: 1, accepted: 0, duplicates: 0 }) },
	});
	invalid.enqueue(snapshot());
	const failed = await invalid.shutdown();
	assert.equal(failed.success, false);
	assert.equal(failed.pending, 1);
});