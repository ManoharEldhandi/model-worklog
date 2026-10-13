import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { TraceSpan } from 'model-worklog-schema';

import { createModelLogger } from './logger';
import type { ModelLoggerOptions } from './types';

function recorder(overrides: Partial<ModelLoggerOptions> = {}) {
	const spans: TraceSpan[] = [];
	const logger = createModelLogger({
		projectId: 'stream', serviceName: 'sdk', flushIntervalMs: 0, onDiagnostic: () => undefined,
		exporter: { export: async (batch) => { spans.push(...batch.spans); return { schemaVersion: 1, accepted: batch.spans.length, duplicates: 0 }; } },
		...overrides,
	});
	return { logger, spans };
}

test('stream preserves chunks and producer return values, consumes once, and scopes context only to producer execution', async () => {
	const { logger, spans } = recorder();
	const chunks = [{ content: 'private-first' }, { content: 'private-second' }];
	let starts = 0;
	const source = async function* () {
		starts += 1;
		assert.ok(logger.currentContext());
		await logger.trace({ name: 'nested' }, async () => undefined);
		yield* chunks;
		return 'original-return';
	};
	const stream = logger.stream({ name: 'stream', kind: 'model' }, source());
	assert.equal(starts, 0);
	assert.equal((await stream.next()).value, chunks[0]);
	assert.equal(logger.currentContext(), undefined);
	assert.equal((await stream.next()).value, chunks[1]);
	assert.deepEqual(await stream.next(), { done: true, value: 'original-return' });
	await logger.shutdown();
	assert.equal(starts, 1);
	const root = spans.find((span) => span.name === 'stream' && span.revision === 2);
	const nested = spans.find((span) => span.name === 'nested');
	assert.equal(root?.state, 'completed');
	assert.equal(nested?.parentSpanId, root?.spanId);
	assert.ok(!JSON.stringify(spans).includes('private-'));
});

test('early consumer cancellation closes the source exactly once and marks the stream interrupted', async () => {
	const { logger, spans } = recorder();
	let cleanups = 0;
	const source = async function* () {
		try { yield 1; yield 2; }
		finally { cleanups += 1; }
	};
	for await (const chunk of logger.stream({ name: 'cancel' }, source())) { assert.equal(chunk, 1); break; }
	await logger.shutdown();
	assert.equal(cleanups, 1);
	assert.equal(spans.at(-1)?.state, 'interrupted');
});

test('stream failures preserve the original error even when source cleanup also fails', async () => {
	const { logger, spans } = recorder();
	const original = new Error('original-private');
	const source: AsyncIterable<number> = {
		[Symbol.asyncIterator]: () => ({
			next: async () => { throw original; },
			return: async () => { throw new Error('cleanup-private'); },
		}),
	};
	await assert.rejects(async () => { for await (const chunk of logger.stream({ name: 'failure' }, source)) { assert.fail(String(chunk)); } }, (error) => error === original);
	await logger.shutdown();
	assert.equal(spans.at(-1)?.state, 'failed');
	assert.ok(!JSON.stringify(spans).includes('private'));
});

test('stream usage hooks and explicit content capture are bounded, redacted, and cannot alter chunks on telemetry failure', async () => {
	const { logger, spans } = recorder({ privacy: { mode: 'redacted-content' }, limits: { maxEvents: 1 } });
	const chunks = [Object.freeze({ text: 'token=private' }), Object.freeze({ text: 'visible' }), Object.freeze({ text: 'last' })];
	const received: unknown[] = [];
	const source = async function* () { yield* chunks; };
	for await (const chunk of logger.stream({
		name: 'content', serializeChunk: (chunk: typeof chunks[number]) => chunk,
		onChunk: (_chunk, span) => { span.recordProviderUsage('openai', { usage: { output_tokens: 0 } }); },
	}, source())) { received.push(chunk); }
	for await (const chunk of logger.stream({
		name: 'broken-hook', serializeChunk: () => { throw new Error('serializer'); },
		onChunk: async () => { throw new Error('hook'); },
	}, source())) { assert.ok(chunks.includes(chunk)); }
	await logger.shutdown();
	assert.deepEqual(received, chunks);
	assert.equal(received[0], chunks[0]);
	const final = spans.find((span) => span.name === 'content' && span.revision === 2);
	assert.equal(final?.events.length, 1);
	assert.equal(final?.capture.droppedEvents, 2);
	assert.equal(final?.usage?.outputTokens, 0);
	assert.equal(final?.usage?.inputTokens, undefined);
	assert.ok(!JSON.stringify(spans).includes('token=private'));
	assert.equal(spans.at(-1)?.state, 'completed');
});

test('metadata mode never invokes a chunk content serializer and lazy streams retain their original parent', async () => {
	const { logger, spans } = recorder();
	let calls = 0;
	const source = async function* () { yield 'private'; };
	const stream = await logger.trace({ name: 'parent' }, async () => logger.stream({ name: 'child', serializeChunk: () => { calls += 1; return 'private'; } }, source()));
	for await (const chunk of stream) { assert.equal(chunk, 'private'); }
	await logger.shutdown();
	assert.equal(calls, 0);
	assert.equal(spans.find((span) => span.name === 'child')?.parentSpanId, spans.find((span) => span.name === 'parent')?.spanId);
});

test('a stream created without a parent does not acquire an unrelated consumer context', async () => {
	const { logger, spans } = recorder();
	const source = async function* () { yield 1; };
	const stream = logger.stream({ name: 'independent' }, source());
	await logger.trace({ name: 'consumer' }, async (parent) => {
		for await (const chunk of stream) {
			assert.equal(chunk, 1);
			assert.equal(logger.currentContext()?.spanId, parent.context.spanId);
		}
	});
	await logger.shutdown();
	assert.equal(spans.find((span) => span.name === 'independent')?.parentSpanId, undefined);
	assert.notEqual(spans.find((span) => span.name === 'independent')?.traceId, spans.find((span) => span.name === 'consumer')?.traceId);
});