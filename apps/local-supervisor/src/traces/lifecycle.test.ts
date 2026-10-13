import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TraceBatchAckSchema, TraceDetailSchema, TraceListSchema, TracePrincipalSchema } from 'model-worklog-schema';
import { createLocalModelLogger, HttpTraceExporter } from 'model-worklog-sdk';

import { startSupervisor } from '../server';
import { api, credential, fixture, traceSpan } from './fixtures.test';

test('trace data, cursors and scoped credentials survive restart; expiry and revocation remain effective', async (context) => {
	let clock = Date.parse('2026-10-13T00:00:00.000Z');
	const now = (): Date => new Date(clock);
	const { supervisor, directory } = await fixture(context, { now });
	const writer = await credential(supervisor, 'writer', ['project'], 60);
	const reader = await credential(supervisor, 'reader');
	const revoked = await credential(supervisor, 'reader');
	const span = traceSpan();
	await api(supervisor, '/v2/traces/batch', writer.token, 'POST', { schemaVersion: 1, spans: [span, traceSpan({ traceId: '2'.repeat(32) })] });
	const page = TraceListSchema.parse(await (await api(supervisor, '/v2/traces?projectId=project&limit=1', reader.token)).json());
	assert.ok(page.nextCursor);
	await api(supervisor, `/v2/credentials/${revoked.id}`, undefined, 'DELETE');
	await supervisor.close();
	const restarted = await startSupervisor({ dataDirectory: directory, now });
	context.after(async () => { await restarted.close(); });
	assert.equal(restarted.authToken, supervisor.authToken);
	const following = TraceListSchema.parse(await (await api(restarted, `/v2/traces?projectId=project&limit=1&cursor=${page.nextCursor}`, reader.token)).json());
	assert.equal(following.traces[0]?.traceId, span.traceId);
	assert.equal(following.nextCursor, null);
	const replay = TraceBatchAckSchema.parse(await (await api(restarted, '/v2/traces/batch', writer.token, 'POST', { schemaVersion: 1, spans: [span] })).json());
	assert.equal(replay.duplicates, 1);
	assert.equal((await api(restarted, '/v2/identity', revoked.token)).status, 401);
	clock += 60_000;
	assert.equal((await api(restarted, '/v2/identity', writer.token)).status, 401);
	assert.equal((await api(restarted, '/v2/traces/batch', writer.token, 'POST', { schemaVersion: 1, spans: [span] })).status, 401);
	assert.equal((await api(restarted, '/v2/identity', reader.token)).status, 200);
	await restarted.close();
});

test('local SDK bootstrap uses a private project writer file and reuses it without rotation', async (context) => {
	const { supervisor, directory } = await fixture(context, { traceProjectId: 'project' });
	const tokenPath = join(directory, 'trace-writer-token');
	const before = await readFile(tokenPath, 'utf8');
	assert.equal((await stat(directory)).mode & 0o777, 0o700);
	assert.equal((await stat(join(directory, 'trace-store'))).mode & 0o777, 0o700);
	for (const path of [tokenPath, join(directory, 'auth-token'), join(directory, 'trace-store', 'traces.sqlite')]) {
		assert.equal((await stat(path)).mode & 0o777, 0o600);
	}
	assert.notEqual(before.trim(), supervisor.authToken);
	assert.deepEqual(TracePrincipalSchema.parse(await (await api(supervisor, '/v2/identity', before.trim())).json()).projects, ['project']);
	const logger = await createLocalModelLogger({
		projectId: 'project', serviceName: 'local-sdk', flushIntervalMs: 0,
		environment: { MODEL_WORKLOG_HOME: directory, MODEL_WORKLOG_SUPERVISOR_URL: supervisor.url },
	});
	await logger.trace({ name: 'local operation' }, async () => 42);
	assert.equal((await logger.shutdown()).success, true);
	await supervisor.close();
	await assert.rejects(startSupervisor({ dataDirectory: directory, traceProjectId: 'other' }), /scoped differently/);
	assert.equal(await readFile(tokenPath, 'utf8'), before);
	const restarted = await startSupervisor({ dataDirectory: directory, traceProjectId: 'project' });
	context.after(async () => { await restarted.close(); });
	assert.equal(await readFile(tokenPath, 'utf8'), before);
	assert.equal((await api(restarted, '/v2/identity', before.trim())).status, 200);
	await restarted.close();
});

test('no global writer is created and a user-owned writer file is never silently replaced', async (context) => {
	const { supervisor, directory } = await fixture(context);
	const path = join(directory, 'trace-writer-token');
	await assert.rejects(readFile(path), { code: 'ENOENT' });
	await supervisor.close();
	await writeFile(path, 'user-owned-token\n', { mode: 0o600 });
	await assert.rejects(startSupervisor({ dataDirectory: directory, traceProjectId: 'project' }), /remove it explicitly/);
	assert.equal(await readFile(path, 'utf8'), 'user-owned-token\n');
	const resumed = await startSupervisor({ dataDirectory: directory });
	context.after(async () => { await resumed.close(); });
	assert.equal((await api(resumed, '/v2/identity')).status, 200);
	await resumed.close();
});

test('failed bind closes SQLite and releases the store lock for a subsequent startup', async (context) => {
	const { supervisor: occupied } = await fixture(context);
	const directory = await mkdtemp(join(tmpdir(), 'trace-bind-failure-'));
	context.after(async () => { await rm(directory, { recursive: true, force: true }); });
	await assert.rejects(startSupervisor({ dataDirectory: directory, port: occupied.port }), { code: 'EADDRINUSE' });
	await assert.rejects(stat(join(directory, 'supervisor.lock')), { code: 'ENOENT' });
	await assert.rejects(stat(join(directory, 'trace-store', 'traces.sqlite-wal')), { code: 'ENOENT' });
	const next = await startSupervisor({ dataDirectory: directory });
	context.after(async () => { await next.close(); });
	const writer = await credential(next, 'writer');
	const exporter = new HttpTraceExporter({ endpoint: next.url, token: writer.token });
	assert.equal((await exporter.export({ schemaVersion: 1, spans: [traceSpan()] })).accepted, 1);
	assert.equal(TraceDetailSchema.parse(await (await api(next, `/v2/traces/${'1'.repeat(32)}?projectId=project`)).json()).spans.length, 1);
	await next.close();
});