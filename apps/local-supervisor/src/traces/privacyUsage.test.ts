import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { TraceDetailSchema, TraceListSchema, type TraceSpan } from 'model-worklog-schema';

import { api, credential, fixture, traceSpan } from './fixtures.test';

test('all external labels and attributes are re-redacted before database or WAL persistence', async (context) => {
	const { supervisor, directory } = await fixture(context);
	const writer = await credential(supervisor, 'writer');
	const secret = `sk-${'s'.repeat(24)}`;
	const span = traceSpan({
		name: secret, serviceName: secret, kind: 'model',
		attributes: { prompt: 'private prompt payload', 'code.function': secret, password: secret },
		events: [{ name: secret, at: '2026-10-13T00:00:00.000Z', attributes: { input: 'private event content' } }],
		usage: { source: 'provider-reported', provider: secret, model: secret, requestId: secret, totalTokens: 0 },
		capture: { mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [secret] },
	});
	assert.equal((await api(supervisor, '/v2/traces/batch', writer.token, 'POST', { schemaVersion: 1, spans: [span] })).status, 200);
	const detail = TraceDetailSchema.parse(await (await api(supervisor, `/v2/traces/${span.traceId}?projectId=project`)).json());
	assert.equal(detail.spans[0]?.span.capture.mode, 'metadata');
	assert.equal(detail.spans[0]?.span.name, '[REDACTED]');
	assert.equal(detail.spans[0]?.span.usage?.requestId, '[REDACTED]');
	const store = join(directory, 'trace-store');
	for (const filename of await readdir(store)) {
		const bytes = await readFile(join(store, filename));
		for (const forbidden of [secret, writer.token, supervisor.authToken, 'private prompt payload', 'private event content']) {
			assert.equal(bytes.includes(Buffer.from(forbidden)), false, `${filename} must not retain sensitive input`);
		}
	}
	await supervisor.close();
	assert.equal((await readFile(join(store, 'traces.sqlite'))).includes(Buffer.from(secret)), false);
});

test('operator content opt-in still enforces exclusions, nested reasoning removal and sender metadata mode', async (context) => {
	const { supervisor } = await fixture(context, { tracePrivacy: { mode: 'redacted-content', excludedKeys: ['excluded'], maxStringLength: 64 } });
	const first = traceSpan({
		attributes: { input: { text: 'retained text', thinking: 'hidden thought', password: 'private password' }, excluded: 'excluded content', result: 'x'.repeat(100) },
		capture: { mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] },
	});
	const second = traceSpan({ traceId: '2'.repeat(32), attributes: { input: 'metadata forbids this' } });
	assert.equal((await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [first, second] })).status, 200);
	const detail = TraceDetailSchema.parse(await (await api(supervisor, `/v2/traces/${first.traceId}?projectId=project`)).json());
	const serialized = JSON.stringify(detail);
	assert.ok(serialized.includes('retained text'));
	for (const forbidden of ['hidden thought', 'private password', 'excluded content']) { assert.equal(serialized.includes(forbidden), false); }
	assert.ok((detail.spans[0]?.span.capture.truncatedFields ?? 0) > 0);
	const metadata = await (await api(supervisor, `/v2/traces/${second.traceId}?projectId=project`)).text();
	assert.equal(metadata.includes('metadata forbids this'), false);
	const summary = TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json());
	assert.equal(summary.traces.find((trace) => trace.traceId === first.traceId)?.incomplete, true);
});

test('usage deduplicates provider requests per trace, ignores root and tool totals, and preserves partial unknowns', async (context) => {
	const { supervisor } = await fixture(context);
	const root = traceSpan({ usage: { source: 'adapter-reported', totalTokens: 999 } });
	const model = (index: number, overrides: Partial<TraceSpan> = {}): TraceSpan => traceSpan({
		spanId: index.toString(16).padStart(16, '0'), parentSpanId: root.spanId, kind: 'model',
		usage: { source: 'provider-reported', provider: 'openai', requestId: 'same-request', totalTokens: 10 }, ...overrides,
	});
	const spans = [root, model(2), model(3), model(4, { kind: 'tool', usage: { source: 'adapter-reported', totalTokens: 500 } }),
		model(5, { usage: { source: 'provider-reported', provider: 'other', requestId: 'same-request', totalTokens: 20 } }),
		model(6, { usage: undefined }), model(7, { usage: { source: 'provider-reported', inputTokens: 7 } }),
		model(8, { state: 'running', endedAt: undefined, usage: { source: 'adapter-reported', totalTokens: 800 } }),
	];
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans });
	let list = TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json());
	assert.equal(list.traces[0]?.totalTokens, 37);
	assert.equal(list.traces[0]?.incomplete, true);
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [model(2), model(3)] });
	list = TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json());
	assert.equal(list.traces[0]?.totalTokens, 37);
	const zero = traceSpan({ traceId: '2'.repeat(32), kind: 'model', usage: { source: 'provider-reported', totalTokens: 0 } });
	const unknown = traceSpan({ traceId: '3'.repeat(32), kind: 'model' });
	const partial = traceSpan({ traceId: '4'.repeat(32), kind: 'model', usage: { source: 'provider-reported', inputTokens: 0 } });
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [zero, unknown, partial] });
	list = TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json());
	assert.equal(list.traces.find((trace) => trace.traceId === zero.traceId)?.totalTokens, 0);
	assert.equal(list.traces.find((trace) => trace.traceId === zero.traceId)?.incomplete, false);
	assert.equal(list.traces.find((trace) => trace.traceId === unknown.traceId)?.totalTokens, undefined);
	assert.equal(list.traces.find((trace) => trace.traceId === partial.traceId)?.totalTokens, 0);
	assert.equal(list.traces.find((trace) => trace.traceId === partial.traceId)?.incomplete, true);
});

test('redacted usage identities do not merge distinct requests and capture loss stays visible', async (context) => {
	const { supervisor } = await fixture(context);
	const root = traceSpan();
	const first = traceSpan({ spanId: '2'.repeat(16), parentSpanId: root.spanId, kind: 'model', usage: { source: 'provider-reported', provider: 'openai', requestId: `sk-${'a'.repeat(24)}`, totalTokens: 10 } });
	const second = traceSpan({ ...first, spanId: '3'.repeat(16), usage: { ...first.usage!, requestId: `sk-${'b'.repeat(24)}`, totalTokens: 20 }, capture: { ...first.capture, droppedEvents: 1 } });
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [root, first, second] });
	const list = TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json());
	assert.equal(list.traces[0]?.totalTokens, 30);
	assert.equal(list.traces[0]?.incomplete, true);
});