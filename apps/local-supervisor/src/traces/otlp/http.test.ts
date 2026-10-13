import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { request } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { Reader } from 'protobufjs';

import { TraceBatchAckSchema, TraceDetailSchema, TraceListSchema } from 'model-worklog-schema';

import type { RunningSupervisor } from '../../server';
import { api, credential, fixture } from '../fixtures.test';
import { otlpBatch } from './convert';
import { decodeOtlp } from './decode';
import { binaryRequest, jsonRequest, jsonSpan, spanId, traceId, wireRequest, wireSpan } from './fixtures.test';
import type { OtlpEncoding, OtlpRequest } from './protocol';

function post(supervisor: RunningSupervisor, token: string, body: OtlpRequest | Buffer, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${supervisor.url}/v1/traces`, { method: 'POST', headers: {
		'x-model-worklog-token': token, 'content-type': Buffer.isBuffer(body) ? 'application/x-protobuf' : 'application/json', ...headers,
	}, body: Buffer.isBuffer(body) ? body : JSON.stringify(body) });
}

async function success(response: Response, encoding: OtlpEncoding): Promise<void> {
	assert.equal(response.status, 200, `OTLP ${encoding} export failed: ${response.status === 200 ? '' : await response.text()}`);
	assert.equal(response.headers.get('content-type'), encoding === 'json' ? 'application/json' : 'application/x-protobuf');
	if (encoding === 'json') { assert.deepEqual(await response.json(), {}); }
	else { assert.equal((await response.arrayBuffer()).byteLength, 0); }
}

function rawPost(supervisor: RunningSupervisor, headers: Record<string, string>, body: Buffer): Promise<number> {
	return new Promise((resolve, reject) => {
		const outgoing = request(`${supervisor.url}/v1/traces`, { method: 'POST', headers }, (response) => {
			response.resume();
			response.once('end', () => { resolve(response.statusCode ?? 0); });
			response.once('error', reject);
		});
		outgoing.once('error', reject);
		outgoing.end(body);
	});
}

for (const encoding of ['json', 'protobuf'] as const) {
	test(`OTLP ${encoding} exports final spans and replays idempotently with protocol success responses`, async (context) => {
		const { supervisor } = await fixture(context, { tracePrivacy: { mode: 'redacted-content' } });
		const writer = await credential(supervisor, 'writer');
		const reader = await credential(supervisor, 'reader');
		const body = encoding === 'json' ? jsonRequest() : wireRequest(wireSpan());
		await success(await post(supervisor, writer.token, body), encoding);
		const detail = async () => TraceDetailSchema.parse(await (await api(supervisor, `/v2/traces/${traceId}?projectId=project`, reader.token)).json());
		const first = await detail();
		assert.equal(first.spans.length, 1);
		const stored = first.spans[0]!;
		assert.equal(stored.evidenceGrade, 'model-declared');
		assert.equal(stored.span.revision, 1);
		assert.equal(stored.span.state, 'failed');
		assert.equal(stored.span.parentSpanId, '1111111111111111');
		assert.equal(stored.span.links.length, 1);
		assert.equal(stored.span.events[0]?.at, '2026-10-13T00:00:00.123Z');
		assert.deepEqual(stored.span.attributes.nested, { values: [true, '-9223372036854775808', 1.25, 'AP8=', null] });
		assert.equal(stored.span.usage?.inputTokens, 7);
		assert.equal(stored.span.usage?.totalTokens, undefined);
		await success(await post(supervisor, writer.token, body), encoding);
		assert.deepEqual(await detail(), first);
		const decoded = decodeOtlp(Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)), encoding);
		await success(await post(supervisor, writer.token, encoding === 'json' ? binaryRequest(decoded) : decoded), encoding === 'json' ? 'protobuf' : 'json');
		assert.deepEqual(await detail(), first);
		const acknowledgement = TraceBatchAckSchema.parse(await (await api(supervisor, '/v2/traces/batch', writer.token, 'POST', otlpBatch(decoded, 'project'))).json());
		assert.deepEqual(acknowledgement, { schemaVersion: 1, accepted: 0, duplicates: 1 });
		const health = await (await fetch(`${supervisor.url}/health`)).json() as { capabilities: { features: string[] } };
		assert.ok(health.capabilities.features.includes(`otlp-http-traces-${encoding}`));
	});

	test(`OTLP ${encoding} batch conflicts and invalid members never partially commit`, async (context) => {
		const { supervisor } = await fixture(context);
		const writer = await credential(supervisor, 'writer');
		const send = (body: OtlpRequest) => post(supervisor, writer.token, encoding === 'json' ? body : binaryRequest(body));
		await success(await send(jsonRequest()), encoding);
		const newTraceId = '3'.repeat(32);
		const fresh = jsonSpan({ traceId: newTraceId });
		assert.equal((await send(jsonRequest([fresh, jsonSpan({ attributes: [{ key: 'private', value: { stringValue: 'changed even though metadata drops it' } }] })]))).status, 409);
		assert.equal((await api(supervisor, `/v2/traces/${newTraceId}?projectId=project`)).status, 404);
		for (const invalid of [jsonSpan({ spanId: '0'.repeat(16) }), jsonSpan({ parentSpanId: spanId }), jsonSpan({ endTimeUnixNano: undefined })]) {
			assert.equal((await send(jsonRequest([fresh, invalid]))).status, 400);
			assert.equal((await api(supervisor, `/v2/traces/${newTraceId}?projectId=project`)).status, 404);
		}
		assert.equal((await send(jsonRequest(Array.from({ length: 101 }, () => fresh)))).status, 400);
		const invalidEnvelope = jsonRequest([fresh]);
		invalidEnvelope.resourceSpans!.push({ resource: { attributes: [{ key: 'duplicate', value: {} }, { key: 'duplicate', value: {} }] } });
		assert.equal((await send(invalidEnvelope)).status, 400);
		assert.equal((await api(supervisor, `/v2/traces/${newTraceId}?projectId=project`)).status, 404);
		const conflicting = jsonRequest([fresh, jsonSpan({ traceId: newTraceId, name: 'conflicting in this batch' })]);
		assert.equal((await send(conflicting)).status, 409);
		assert.equal((await api(supervisor, `/v2/traces/${newTraceId}?projectId=project`)).status, 404);
	});

	test(`OTLP ${encoding} rejects unauthorized roles and project scopes before parsing bodies`, async (context) => {
		const { supervisor } = await fixture(context);
		const writer = await credential(supervisor, 'writer');
		const reader = await credential(supervisor, 'reader');
		const multi = await credential(supervisor, 'writer', ['project', 'other']);
		const body = encoding === 'json' ? jsonRequest() : binaryRequest(jsonRequest());
		const contentType = encoding === 'json' ? 'application/json' : 'application/x-protobuf';
		for (const token of ['', 'incorrect']) {
			const response = await post(supervisor, token, Buffer.from('malformed'), { 'content-type': contentType, 'x-model-worklog-role': 'admin' });
			assert.equal(response.status, 401);
			if (encoding === 'protobuf') {
				const failure = Reader.create(Buffer.from(await response.arrayBuffer()));
				assert.equal(failure.uint32(), 18);
				assert.match(failure.string(), /credential/);
			} else { assert.match((await response.json() as { message: string }).message, /credential/); }
		}
		assert.equal((await post(supervisor, reader.token, Buffer.from('malformed'), { 'content-type': contentType, 'x-model-worklog-role': 'admin' })).status, 403);
		assert.equal((await post(supervisor, writer.token, Buffer.from('malformed'), { 'content-type': contentType, 'x-model-worklog-project': 'other', 'x-model-worklog-role': 'admin' })).status, 403);
		assert.equal((await post(supervisor, multi.token, body)).status, 400);
		assert.equal((await post(supervisor, supervisor.authToken, body)).status, 400);
		assert.equal((await post(supervisor, writer.token, body, { 'x-model-worklog-project': '../other' })).status, 400);
		await success(await post(supervisor, multi.token, body, { 'x-model-worklog-project': 'other' }), encoding);
		assert.equal((await api(supervisor, `/v2/traces/${traceId}?projectId=project`)).status, 404);
		assert.equal((await api(supervisor, `/v2/traces/${traceId}?projectId=other`)).status, 200);
		await success(await post(supervisor, supervisor.authToken, body, { 'x-model-worklog-project': 'admin-project' }), encoding);
		assert.equal((await api(supervisor, '/v1/sessions', writer.token)).status, 401);
		assert.equal((await api(supervisor, '/v1/runs', writer.token, 'POST', {})).status, 401);
	});
}

test('OTLP browser, MIME, compression and 2 MiB guards run before decoding or intake', async (context) => {
	const { supervisor } = await fixture(context);
	const writer = await credential(supervisor, 'writer');
	const body = binaryRequest(jsonRequest());
	assert.equal((await post(supervisor, writer.token, body, { origin: 'https://untrusted.example' })).status, 403);
	assert.equal(await rawPost(supervisor, { 'x-model-worklog-token': writer.token, 'content-type': 'application/x-protobuf', host: 'attacker.example' }, body), 403);
	assert.equal((await post(supervisor, writer.token, body, { 'sec-fetch-site': 'cross-site' })).status, 403);
	assert.equal((await post(supervisor, writer.token, body, { 'content-type': 'text/plain' })).status, 415);
	assert.equal((await post(supervisor, writer.token, body, { 'content-encoding': 'br' })).status, 415);
	for (const contentType of ['application/json', 'application/x-protobuf']) {
		const large = Buffer.alloc(2_097_153, 120);
		const headers = { 'x-model-worklog-token': writer.token, 'content-type': contentType };
		assert.equal((await post(supervisor, writer.token, gzipSync(large), { 'content-type': contentType, 'content-encoding': 'gzip' })).status, 415);
		assert.equal((await post(supervisor, writer.token, large, { 'content-type': contentType })).status, 413);
		assert.equal(await rawPost(supervisor, { ...headers, 'transfer-encoding': 'chunked' }, large), 413);
		assert.equal(await rawPost(supervisor, { ...headers, 'content-length': '9000000' }, Buffer.from('{')), 413);
		assert.equal(await rawPost(supervisor, { ...headers, 'x-model-worklog-token': '', 'content-length': '9000000' }, Buffer.from('{')), 401);
		assert.equal((await post(supervisor, writer.token, Buffer.from([255]), { 'content-type': contentType })).status, 400);
	}
	assert.equal((await api(supervisor, '/v1/traces', writer.token, 'GET')).status, 400);
	assert.equal((await api(supervisor, '/v1/traces?projectId=project', writer.token, 'POST', jsonRequest())).status, 400);
	assert.equal(TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json()).traces.length, 0);
	await success(await post(supervisor, writer.token, body, { origin: supervisor.url, 'content-encoding': 'identity' }), 'protobuf');
});

test('OTLP uses intake quotas transactionally and does not replace failures with partial success', async (context) => {
	for (const encoding of ['json', 'protobuf'] as const) {
		const { supervisor } = await fixture(context, { traceStorage: { maxStoredSpans: 1 } });
		const writer = await credential(supervisor, 'writer');
		const body = jsonRequest([jsonSpan(), jsonSpan({ spanId: '4'.repeat(16) })]);
		const response = await post(supervisor, writer.token, encoding === 'json' ? body : binaryRequest(body));
		assert.equal(response.status, 507);
		assert.equal(TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project')).json()).traces.length, 0);
	}
});

test('OTLP redacts all surfaces and drops raw reasoning before SQLite and WAL persistence', async (context) => {
	const { supervisor, directory } = await fixture(context, { tracePrivacy: { mode: 'redacted-content' } });
	const writer = await credential(supervisor, 'writer');
	const secret = `sk-${'s'.repeat(24)}`;
	const body = jsonRequest([jsonSpan({
		name: secret, status: { code: 2, message: secret },
		attributes: [
			{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
			{ key: 'gen_ai.provider.name', value: { stringValue: secret } }, { key: 'gen_ai.response.id', value: { stringValue: secret } },
			{ key: 'gen_ai.request.model', value: { stringValue: secret } }, { key: 'gen_ai.usage.output_tokens', value: { intValue: '0' } },
			{ key: 'gen_ai.output.messages', value: { stringValue: JSON.stringify([{ parts: [{ type: 'thinking', content: 'raw private thought' }, { type: 'text', content: 'visible answer' }] }]) } },
			{ key: 'payload', value: { kvlistValue: { values: [{ key: 'password', value: { stringValue: 'private password' } }] } } },
		],
		events: [{ name: 'reasoning.delta', timeUnixNano: jsonSpan().startTimeUnixNano, attributes: [{ key: 'text', value: { stringValue: 'raw private event' } }] },
			{ name: secret, timeUnixNano: jsonSpan().startTimeUnixNano, attributes: [] }],
		links: [{ traceId: '2'.repeat(32), spanId: '2'.repeat(16), traceState: secret, attributes: [{ key: 'reasoning', value: { stringValue: 'raw private linked thought' } }] }],
	})]);
	body.resourceSpans![0]!.resource!.attributes = [{ key: 'service.name', value: { stringValue: secret } }];
	body.resourceSpans![0]!.scopeSpans![0]!.scope!.name = secret;
	await success(await post(supervisor, writer.token, binaryRequest(body)), 'protobuf');
	const detail = TraceDetailSchema.parse(await (await api(supervisor, `/v2/traces/${traceId}?projectId=project`)).json());
	assert.equal(detail.spans[0]?.span.name, '[REDACTED]');
	assert.equal(detail.spans[0]?.span.serviceName, '[REDACTED]');
	assert.equal(detail.spans[0]?.span.usage?.outputTokens, 0);
	assert.equal(detail.spans[0]?.span.usage?.inputTokens, undefined);
	assert.equal(detail.spans[0]?.span.usage?.totalTokens, undefined);
	assert.equal(detail.spans[0]?.span.usage?.requestId, '[REDACTED]');
	assert.equal(detail.spans[0]?.span.events.length, 1);
	assert.ok(JSON.stringify(detail).includes('visible answer'));
	const store = join(directory, 'trace-store');
	for (const filename of await readdir(store)) {
		const bytes = await readFile(join(store, filename));
		for (const forbidden of [secret, writer.token, supervisor.authToken, 'raw private', 'private password']) {
			assert.equal(bytes.includes(Buffer.from(forbidden)), false, `${filename} must not persist raw OTLP secrets or reasoning`);
		}
	}
});

test('OTLP metadata defaults, explicit projects across resources, and unknown token counts survive intake', async (context) => {
	const { supervisor } = await fixture(context);
	const writer = await credential(supervisor, 'writer', ['project', 'other']);
	const input = jsonRequest([jsonSpan({ parentSpanId: '', attributes: [{ key: 'prompt', value: { stringValue: 'private content' } }] })]);
	input.resourceSpans!.push(...jsonRequest([jsonSpan({ traceId: '2'.repeat(32), attributes: [{ key: 'gen_ai.usage.output_tokens', value: { intValue: '0' } }] })]).resourceSpans!);
	await success(await post(supervisor, writer.token, input, { 'x-model-worklog-project': 'project', 'content-type': 'application/json; charset=utf-8' }), 'json');
	const first = TraceDetailSchema.parse(await (await api(supervisor, `/v2/traces/${traceId}?projectId=project`)).json()).spans[0]!;
	assert.equal(first.span.usage, undefined);
	assert.equal(first.span.capture.mode, 'metadata');
	assert.equal(JSON.stringify(first).includes('private content'), false);
	const second = TraceDetailSchema.parse(await (await api(supervisor, `/v2/traces/${'2'.repeat(32)}?projectId=project`)).json()).spans[0]!;
	assert.equal(second.span.usage?.outputTokens, 0);
	assert.equal(second.span.usage?.totalTokens, undefined);
	assert.equal(TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=other')).json()).traces.length, 0);
});

test('OTLP accepts exactly 100 spans and enforces the limit across resource and scope groups', async (context) => {
	for (const encoding of ['json', 'protobuf'] as const) {
		const { supervisor } = await fixture(context);
		const writer = await credential(supervisor, 'writer');
		const spans = Array.from({ length: 100 }, (_, index) => jsonSpan({ spanId: (index + 1).toString(16).padStart(16, '0'), parentSpanId: '' }));
		const input = jsonRequest(spans.slice(0, 50));
		input.resourceSpans!.push(...jsonRequest(spans.slice(50)).resourceSpans!);
		const send = () => post(supervisor, writer.token, encoding === 'json' ? input : binaryRequest(input));
		await success(await send(), encoding);
		const original = TraceDetailSchema.parse(await (await api(supervisor, `/v2/traces/${traceId}?projectId=project`)).json());
		assert.equal(original.spans.length, 100);
		input.resourceSpans![1]!.scopeSpans!.push({ spans: [jsonSpan({ spanId: 'f'.repeat(16), parentSpanId: '' })] });
		assert.equal((await send()).status, 400);
		assert.deepEqual(TraceDetailSchema.parse(await (await api(supervisor, `/v2/traces/${traceId}?projectId=project`)).json()), original);
	}
});