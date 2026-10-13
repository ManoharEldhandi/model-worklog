import assert from 'node:assert/strict';
import test from 'node:test';

import { API_VERSION, TraceBatchAckSchema, TraceDetailSchema, TraceListSchema, TracePrincipalSchema } from 'model-worklog-schema';
import { HttpTraceExporter, createModelLogger } from 'model-worklog-sdk';

import { api, credential, fixture, traceSpan } from './fixtures.test';

test('real SDK logger and HTTP exporter ingest into the ephemeral supervisor', async (context) => {
	const { supervisor } = await fixture(context);
	const writer = await credential(supervisor, 'writer');
	const reader = await credential(supervisor, 'reader');
	const logger = createModelLogger({ projectId: 'project', serviceName: 'sdk-integration', flushIntervalMs: 0, exporter: new HttpTraceExporter({ endpoint: supervisor.url, token: writer.token }) });
	await logger.trace({ name: 'agent', kind: 'agent' }, async (root) => {
		root.setUsage({ source: 'adapter-reported', totalTokens: 999 });
		await logger.trace({ name: 'tool', kind: 'tool' }, async (tool) => { tool.setUsage({ source: 'adapter-reported', totalTokens: 888 }); });
		await logger.trace({ name: 'model', kind: 'model' }, async (model) => {
			model.recordProviderUsage('openai', { id: 'provider-response', usage: { input_tokens: 10, output_tokens: 0, total_tokens: 10 } });
		});
	});
	assert.equal((await logger.shutdown()).success, true);
	const list = TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project', reader.token)).json());
	assert.equal(list.traces.length, 1);
	assert.equal(list.traces[0]?.totalTokens, 10);
	assert.equal(list.traces[0]?.incomplete, false);
	const detail = TraceDetailSchema.parse(await (await api(supervisor, `/v2/traces/${list.traces[0]?.traceId}?projectId=project`, reader.token)).json());
	assert.equal(detail.spans.length, 3);
	assert.ok(detail.spans.every((stored) => stored.evidenceGrade === 'model-declared' && stored.span.revision === 2));
	const health = await (await fetch(`${supervisor.url}/health`)).json() as { apiVersion: string; capabilities: { features: string[] } };
	assert.equal(health.apiVersion, API_VERSION);
	assert.ok(health.capabilities.features.includes('traces-v2'));
});

test('reader, writer and admin powers are derived from credentials and never from role headers', async (context) => {
	const { supervisor } = await fixture(context);
	const writer = await credential(supervisor, 'writer');
	const reader = await credential(supervisor, 'reader');
	for (const [token, role] of [[writer.token, 'writer'], [reader.token, 'reader'], [supervisor.authToken, 'admin']] as const) {
		assert.equal(TracePrincipalSchema.parse(await (await api(supervisor, '/v2/identity', token)).json()).role, role);
	}
	assert.equal((await api(supervisor, '/v2/traces?projectId=project', writer.token, 'GET', undefined, { 'x-model-worklog-role': 'admin' })).status, 403);
	assert.equal((await api(supervisor, '/v2/credentials', writer.token, 'POST', { role: 'reader', projects: ['project'] }, { 'x-model-worklog-role': 'admin' })).status, 403);
	assert.equal((await api(supervisor, '/v1/sessions', writer.token)).status, 401);
	assert.equal((await api(supervisor, '/v1/runs', reader.token, 'POST', {})).status, 401);
	assert.equal((await api(supervisor, '/v2/traces/batch', reader.token, 'POST', { schemaVersion: 1, spans: [traceSpan()] })).status, 403);
	const sent = await api(supervisor, '/v2/traces/batch', writer.token, 'POST', { schemaVersion: 1, spans: [traceSpan()] });
	assert.deepEqual(TraceBatchAckSchema.parse(await sent.json()), { schemaVersion: 1, accepted: 1, duplicates: 0 });
	assert.equal((await api(supervisor, '/v2/traces?projectId=other', reader.token)).status, 403);
	assert.equal((await api(supervisor, `/v2/traces/${'1'.repeat(32)}?projectId=other`, reader.token)).status, 403);
	assert.equal((await api(supervisor, `/v2/credentials/${reader.id}`, supervisor.authToken, 'DELETE')).status, 200);
	assert.equal((await api(supervisor, '/v2/identity', reader.token)).status, 401);
});

test('authentication and browser guards precede JSON parsing and body bounds', async (context) => {
	const { supervisor } = await fixture(context);
	const url = `${supervisor.url}/v2/traces/batch`;
	assert.equal((await fetch(url, { method: 'POST', body: '{malformed', headers: { 'x-model-worklog-role': 'admin' } })).status, 401);
	assert.equal((await fetch(url, { method: 'POST', body: 'x'.repeat(2_097_153) })).status, 401);
	assert.equal((await fetch(url, { method: 'POST', body: '{}', headers: { 'x-model-worklog-token': supervisor.authToken } })).status, 400);
	assert.equal((await fetch(url, { method: 'POST', body: '{malformed', headers: { 'x-model-worklog-token': supervisor.authToken, 'content-type': 'application/json' } })).status, 400);
	assert.equal((await fetch(url, { method: 'POST', body: 'x'.repeat(2_097_153), headers: { 'x-model-worklog-token': supervisor.authToken, 'content-type': 'application/json' } })).status, 413);
	const crossOrigin = await api(supervisor, '/v2/identity', supervisor.authToken, 'GET', undefined, { origin: 'https://untrusted.example' });
	assert.equal(crossOrigin.status, 403);
	assert.equal(crossOrigin.headers.has('access-control-allow-origin'), false);
	assert.equal((await api(supervisor, '/v2/identity', supervisor.authToken, 'GET', undefined, { origin: supervisor.url })).status, 200);
	assert.equal((await api(supervisor, '/v2/traces/batch', supervisor.authToken, 'POST', { schemaVersion: 1, spans: [{ ...traceSpan(), evidenceGrade: 'observed-native' }] })).status, 400);
});