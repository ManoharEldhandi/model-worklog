import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { TraceSpanSchema, type TraceSpan } from 'model-worklog-schema';

import type { TraceDiagnostic } from './diagnostics';
import { createLocalModelLogger } from './local';
import { createModelLogger } from './logger';
import type { ModelLoggerOptions, TraceSpanHandle } from './types';

function recordingLogger(overrides: Partial<ModelLoggerOptions> = {}) {
	const spans: TraceSpan[] = [];
	const diagnostics: TraceDiagnostic[] = [];
	const logger = createModelLogger({
		projectId: 'test', serviceName: 'sdk', flushIntervalMs: 0, onDiagnostic: (event) => { diagnostics.push(event); },
		exporter: { export: async (batch) => { spans.push(...batch.spans); return { schemaVersion: 1, accepted: batch.spans.length, duplicates: 0 }; } },
		...overrides,
	});
	return { logger, spans, diagnostics };
}

test('nested and concurrent traces have isolated parentage and independent loggers never share context', async () => {
	const first = recordingLogger();
	const second = recordingLogger();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	await Promise.all(['left', 'right'].map((name) => first.logger.trace({ name, kind: 'agent' }, async (root) => {
		if (name === 'right') { release?.(); }
		await gate;
		assert.equal(first.logger.currentContext()?.spanId, root.context.spanId);
		await first.logger.trace({ name: `${name}-child`, kind: 'tool' }, async () => Promise.resolve());
		await second.logger.trace({ name }, async () => undefined);
	})));
	await first.logger.shutdown();
	await second.logger.shutdown();
	const finals = first.spans.filter((span) => span.state === 'completed');
	for (const name of ['left', 'right']) {
		const root = finals.find((span) => span.name === name);
		const child = finals.find((span) => span.name === `${name}-child`);
		assert.ok(root && child);
		assert.equal(child.parentSpanId, root.spanId);
		assert.equal(child.traceId, root.traceId);
		assert.equal(root.parentSpanId, undefined);
	}
	assert.notEqual(finals.find((span) => span.name === 'left')?.traceId, finals.find((span) => span.name === 'right')?.traceId);
	assert.ok(second.spans.every((span) => span.parentSpanId === undefined));
	assert.equal(first.logger.currentContext(), undefined);
	assert.ok(first.spans.every((span) => TraceSpanSchema.safeParse(span).success));
	assert.equal(first.spans.filter((span) => span.revision === 1).length, 4);
	assert.equal(first.spans.filter((span) => span.revision === 2).length, 4);
});

test('remote parents, explicit roots, links, and wrap preserve context, receiver, arguments, and result identity', async () => {
	const { logger, spans } = recordingLogger();
	const parent = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), traceFlags: 0, isRemote: true };
	const link = { traceId: 'c'.repeat(32), spanId: 'd'.repeat(16) };
	const value = { result: true };
	const receiver = { value, method: logger.wrap({ name: 'wrapped' }, async function (this: { value: typeof value }, first: number, second: string) {
		assert.equal(first, 3); assert.equal(second, 'argument'); return this.value;
	}) };
	await logger.trace({ name: 'remote', parent, links: [link] }, async (span) => {
		assert.equal(span.context.traceFlags, 0);
		assert.equal(await receiver.method(3, 'argument'), value);
		await logger.trace({ name: 'root', parent: null }, async () => undefined);
	});
	await logger.shutdown();
	assert.equal(spans.find((span) => span.name === 'remote')?.parentSpanId, parent.spanId);
	assert.deepEqual(spans.find((span) => span.name === 'remote')?.links, [link]);
	assert.notEqual(spans.find((span) => span.name === 'root')?.traceId, parent.traceId);
});

test('application errors survive serializer, hostile attribute, exporter, and diagnostic-handler failures', async () => {
	const { logger, diagnostics, spans } = recordingLogger({ privacy: { mode: 'redacted-content' } });
	const result = { original: true };
	assert.equal(await logger.trace({ name: 'success', serializeResult: () => { throw new Error('serializer-secret'); } }, async (span) => {
		span.setAttributes(new Proxy({}, { ownKeys: () => { throw new Error('proxy-secret'); } }));
		return result;
	}), result);
	const original = new Error('application-secret');
	await assert.rejects(logger.trace({ name: 'failure' }, async () => { throw original; }), (error) => error === original);
	await logger.shutdown();
	assert.equal(spans.find((span) => span.name === 'failure' && span.revision === 2)?.state, 'failed');
	assert.equal(spans.find((span) => span.name === 'success' && span.revision === 2)?.state, 'completed');
	assert.ok(!JSON.stringify({ diagnostics, spans }).includes('secret'));
	const broken = recordingLogger({ onDiagnostic: () => { throw new Error('handler-secret'); }, exporter: { export: async () => { throw new Error('exporter-secret'); } } });
	assert.equal(await broken.logger.trace({ name: 'working' }, async () => result), result);
	await assert.rejects(broken.logger.trace({ name: 'failing' }, async () => { throw original; }), (error) => error === original);
	const outcome = await broken.logger.shutdown();
	assert.equal(outcome.success, false);
	assert.equal(outcome.pending, 4);
	assert.ok(outcome.diagnosticFailures > 0);
});

test('span input, output, events, usage, and attributes are detached and redacted before enqueue', async () => {
	const { logger, spans } = recordingLogger({ privacy: { mode: 'redacted-content' } });
	const input = { text: 'visible', password: 'private', reasoning: 'hidden' };
	let handle: TraceSpanHandle | undefined;
	await logger.trace({ name: 'model', kind: 'model', input, serializeResult: (result: typeof input) => result }, async (span) => {
		handle = span;
		span.addEvent('result', { body: input });
		span.recordProviderUsage('openai', { id: 'response', usage: { input_tokens: 0 } });
		return input;
	});
	input.text = 'mutated';
	handle?.setAttribute('late', true);
	await logger.shutdown();
	const final = spans.find((span) => span.revision === 2);
	assert.ok(final);
	assert.equal(final.usage?.requestId, 'response');
	assert.equal(final.usage?.inputTokens, 0);
	assert.equal(final.usage?.outputTokens, undefined);
	assert.ok(!JSON.stringify(spans).match(/"(?:private|hidden|mutated|late)"/));
	assert.ok(Object.isFrozen(final.events[0]?.attributes.body));
	assert.deepEqual(spans[0]?.events, []);
	const metadata = recordingLogger();
	let serializerCalls = 0;
	await metadata.logger.trace({ name: 'metadata', input, serializeResult: () => { serializerCalls += 1; return input; } }, async () => input);
	await metadata.logger.shutdown();
	assert.equal(serializerCalls, 0);
	assert.ok(!JSON.stringify(metadata.spans).includes('visible'));
});

test('shutdown interrupts active spans, is idempotent, and does not change ongoing application execution', async () => {
	const { logger, spans } = recordingLogger();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const operation = logger.trace({ name: 'active' }, async () => { await gate; return 42; });
	const first = await logger.shutdown();
	assert.equal(first.success, true);
	assert.equal(await logger.shutdown(), first);
	release?.();
	assert.equal(await operation, 42);
	assert.equal(spans.at(-1)?.state, 'interrupted');
	assert.equal(await logger.trace({ name: 'after-shutdown' }, async () => 7), 7);
});

test('local factory reads only the dedicated writer credential and explicit tokens bypass disk', async () => {
	const home = await mkdtemp(join(tmpdir(), 'model-worklog-token-'));
	try {
		await writeFile(join(home, 'auth-token'), 'admin-secret', { mode: 0o600 });
		await assert.rejects(createLocalModelLogger({ projectId: 'test', serviceName: 'sdk', environment: { MODEL_WORKLOG_HOME: home, MODEL_WORKLOG_TOKEN: 'admin-secret' } }));
		await writeFile(join(home, 'trace-writer-token'), 'writer-token\n', { mode: 0o600 });
		for (const token of [undefined, 'explicit-writer']) {
			const logger = await createLocalModelLogger({
				projectId: 'test', serviceName: 'sdk', token, environment: { MODEL_WORKLOG_HOME: token === undefined ? home : '/nonexistent' },
				fetchImpl: async (_input, init) => {
					assert.equal(new Headers(init?.headers).get('x-model-worklog-token'), token ?? 'writer-token');
					const body = JSON.parse(String(init?.body)) as { spans: unknown[] };
					return Response.json({ schemaVersion: 1, accepted: body.spans.length, duplicates: 0 });
				},
			});
			await logger.trace({ name: 'local' }, async () => undefined);
			assert.equal((await logger.shutdown()).success, true);
		}
	} finally { await rm(home, { recursive: true, force: true }); }
});