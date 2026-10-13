import assert from 'node:assert/strict';
import test from 'node:test';

import { TraceDetailSchema, TraceListSchema } from 'model-worklog-schema';

import { api, credential, fixture, traceSpan } from './fixtures.test';

test('indexed list and detail cursors page every record without omissions or revision movement', async (context) => {
	const { supervisor } = await fixture(context);
	const reader = await credential(supervisor, 'reader', ['project', 'other']);
	const roots = Array.from({ length: 17 }, (_, index) => traceSpan({ traceId: (index + 1).toString(16).padStart(32, '0') }));
	assert.equal((await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: roots })).status, 200);
	const identifiers: string[] = [];
	let cursor: string | null = null;
	let firstCursor: string | undefined;
	do {
		const page = TraceListSchema.parse(await (await api(supervisor, `/v2/traces?projectId=project&limit=3${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, reader.token)).json());
		identifiers.push(...page.traces.map((trace) => trace.traceId));
		cursor = page.nextCursor;
		firstCursor ??= cursor ?? undefined;
	} while (cursor !== null);
	assert.deepEqual(identifiers, roots.map((span) => span.traceId).reverse());
	assert.equal(new Set(identifiers).size, 17);
	assert.ok(firstCursor);
	assert.equal((await api(supervisor, `/v2/traces?projectId=other&cursor=${firstCursor}`, reader.token)).status, 400);
	assert.equal((await api(supervisor, `/v2/traces?projectId=project&cursor=${firstCursor}x`, reader.token)).status, 400);
	const root = roots[0]!;
	const children = Array.from({ length: 12 }, (_, index) => traceSpan({ traceId: root.traceId, spanId: (index + 2).toString(16).padStart(16, '0'), parentSpanId: root.spanId }));
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: children });
	const collected: string[] = [];
	const sequences: number[] = [];
	cursor = null;
	do {
		const page = TraceDetailSchema.parse(await (await api(supervisor, `/v2/traces/${root.traceId}?projectId=project&limit=4${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, reader.token)).json());
		collected.push(...page.spans.map((entry) => entry.span.spanId));
		sequences.push(...page.spans.map((entry) => entry.sequence));
		cursor = page.nextCursor;
		if (collected.length === 4) {
			await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [{ ...root, revision: 2 }] });
			assert.equal((await api(supervisor, `/v2/traces/${roots[1]!.traceId}?projectId=project&cursor=${cursor}`, reader.token)).status, 400);
		}
	} while (cursor !== null);
	assert.deepEqual(collected, [root.spanId, ...children.map((span) => span.spanId)]);
	assert.deepEqual(sequences, [...sequences].sort((left, right) => left - right));
	assert.equal((await api(supervisor, `/v2/traces/${root.traceId}?projectId=project&cursor=${firstCursor}`, reader.token)).status, 400);
});

test('root arrival repairs orphan summary without changing list pagination position', async (context) => {
	const { supervisor } = await fixture(context);
	const root = traceSpan({ name: 'real root', serviceName: 'root service', startedAt: '2026-10-12T00:00:00.000Z' });
	const child = traceSpan({ spanId: '2'.repeat(16), parentSpanId: root.spanId, name: 'orphan', state: 'running', endedAt: undefined });
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [child] });
	let list = TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json());
	assert.equal(list.traces[0]?.name, 'orphan');
	assert.equal(list.traces[0]?.incomplete, true);
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [root] });
	list = TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json());
	assert.equal(list.traces[0]?.name, 'real root');
	assert.equal(list.traces[0]?.serviceName, 'root service');
	assert.equal(list.traces[0]?.startedAt, root.startedAt);
	assert.equal(list.traces[0]?.state, 'running');
	assert.equal(list.traces[0]?.incomplete, true);
	await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: [{ ...child, state: 'completed', endedAt: root.endedAt, revision: 2 }] });
	list = TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json());
	assert.equal(list.traces[0]?.incomplete, false);
});

test('query validation enforces project, cardinality, page limits and supported methods', async (context) => {
	const { supervisor } = await fixture(context);
	for (const path of [
		'/v2/traces', '/v2/traces?projectId=*', '/v2/traces?projectId=project&limit=101',
		'/v2/traces?projectId=project&limit=0', '/v2/traces?projectId=project&limit=1e2',
		'/v2/traces?projectId=project&projectId=other', '/v2/traces?projectId=project&unknown=1',
		`/v2/traces/${'1'.repeat(32)}?projectId=project&limit=1001`,
		'/v2/traces?projectId=project&cursor=', '/v2/identity?role=admin',
	]) { assert.equal((await api(supervisor, path)).status, 400); }
	assert.equal((await api(supervisor, '/v2/identity', undefined, 'POST', {})).status, 400);
	assert.equal((await api(supervisor, '/v2/unknown')).status, 404);
	assert.equal((await api(supervisor, `/v2/traces/${'9'.repeat(32)}?projectId=project`)).status, 404);
});

test('detail pagination also bounds bytes and exports every retained span across pages', async (context) => {
	const { supervisor } = await fixture(context, { tracePrivacy: { mode: 'redacted-content', maxStringLength: 16_000 } });
	const attributes = Object.fromEntries(Array.from({ length: 5 }, (_, index) => [`field${index}`, 'x'.repeat(16_000)]));
	const spans = Array.from({ length: 64 }, (_, index) => traceSpan({
		spanId: (index + 1).toString(16).padStart(16, '0'), parentSpanId: index === 0 ? undefined : '1'.padStart(16, '0'),
		attributes, capture: { mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] },
	}));
	for (let offset = 0; offset < spans.length; offset += 10) {
		assert.equal((await api(supervisor, '/v2/traces/batch', undefined, 'POST', { schemaVersion: 1, spans: spans.slice(offset, offset + 10) })).status, 200);
	}
	const collected: string[] = [];
	let cursor: string | null = null;
	let pages = 0;
	do {
		const response = await api(supervisor, `/v2/traces/${'1'.repeat(32)}?projectId=project&limit=1000${cursor === null ? '' : `&cursor=${cursor}`}`);
		const payload = await response.text();
		assert.ok(Buffer.byteLength(payload) <= 4 * 1024 * 1024);
		const detail = TraceDetailSchema.parse(JSON.parse(payload) as unknown);
		collected.push(...detail.spans.map((entry) => entry.span.spanId));
		cursor = detail.nextCursor;
		pages += 1;
	} while (cursor !== null);
	assert.ok(pages > 1);
	assert.deepEqual(collected, spans.map((span) => span.spanId));
});

test('redaction expansion cannot create an oversized retained span or bypass the response byte budget', async (context) => {
	const { supervisor } = await fixture(context, { tracePrivacy: { mode: 'redacted-content' } });
	const attributes = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, 'token=a '.repeat(15)]));
	const span = traceSpan({
		events: Array.from({ length: 128 }, (_, index) => ({ name: `event-${index}`, at: '2026-10-13T00:00:00.000Z', attributes })),
		capture: { mode: 'redacted-content', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] },
	});
	const body = { schemaVersion: 1, spans: [span] };
	assert.ok(Buffer.byteLength(JSON.stringify(body)) < 2 * 1024 * 1024);
	const response = await api(supervisor, '/v2/traces/batch', undefined, 'POST', body);
	assert.equal(response.status, 413);
	assert.equal((await response.json() as { error: { code: string } }).error.code, 'span_too_large');
	assert.equal(TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json()).traces.length, 0);
});