import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalModelLogger } from 'model-worklog-sdk';
import { TraceDetailSchema, TraceListSchema } from 'model-worklog-schema';
import { createTraceCredential, startSupervisor } from 'model-worklog-supervisor';

const directory = await realpath(await mkdtemp(join(tmpdir(), 'model-worklog-sdk-demo-')));
let collector;
let logger;
try {
	collector = await startSupervisor({ port: 0, dataDirectory: directory, tracePrivacy: { mode: 'redacted-content' } });
	const writer = await createTraceCredential({ url: collector.url, adminToken: collector.authToken, role: 'writer', projects: ['example'] });
	logger = await createLocalModelLogger({
		projectId: 'example', serviceName: 'package-inspector', endpoint: collector.url, token: writer.token,
		privacy: { mode: 'redacted-content' },
	});
	await logger.trace({ name: 'inspect-package', kind: 'agent' }, async () => {
		await logger.trace({
			name: 'read-package', kind: 'tool', attributes: { 'tool.name': 'readFile' },
			serializeResult: (metadata) => ({ name: metadata.name, version: metadata.version }),
		}, async () => JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')));
	});
	const delivery = await logger.shutdown();
	assert.equal(delivery.success, true);
	const reader = await createTraceCredential({ url: collector.url, adminToken: collector.authToken, role: 'reader', projects: ['example'] });
	const headers = { 'x-model-worklog-token': reader.token };
	const listed = await fetch(new URL('/v2/traces?projectId=example', collector.url), { headers });
	assert.equal(listed.status, 200);
	const summary = TraceListSchema.parse(await listed.json()).traces[0];
	assert.ok(summary);
	const details = await fetch(new URL(`/v2/traces/${summary.traceId}?projectId=example`, collector.url), { headers });
	const spans = TraceDetailSchema.parse(await details.json()).spans;
	assert.equal(spans.length, 2);
	assert.equal(summary.state, 'completed');
	assert.ok(spans.every((stored) => stored.evidenceGrade === 'model-declared'));
	console.log(JSON.stringify({ traceId: summary.traceId, state: summary.state, spans: spans.length, tokens: summary.totalTokens ?? 'not reported', delivery: delivery.success }, null, 2));
} finally {
	await logger?.shutdown();
	await collector?.close();
	await rm(directory, { recursive: true, force: true });
}