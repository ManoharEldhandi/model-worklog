import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import type { TraceBatch } from 'model-worklog-schema';

import { TraceExportError } from './exporter';
import { HttpTraceExporter } from './http';

const batch: TraceBatch = {
	schemaVersion: 1,
	spans: [{
		schemaVersion: 1, projectId: 'test', serviceName: 'sdk', name: 'request', kind: 'model',
		traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), revision: 1, state: 'running',
		startedAt: '2026-10-13T00:00:00.000Z', attributes: {}, events: [], links: [],
		capture: { mode: 'metadata', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] },
	}],
};

test('trace HTTP exporter posts the shared batch and validates a complete acknowledgement', async () => {
	const exporter = new HttpTraceExporter({
		token: 'writer-token', endpoint: 'http://[::1]:43199',
		fetchImpl: async (input, init) => {
			assert.equal(String(input), 'http://[::1]:43199/v2/traces/batch');
			assert.equal(init?.method, 'POST');
			assert.equal(init?.redirect, 'error');
			assert.equal(new Headers(init?.headers).get('x-model-worklog-token'), 'writer-token');
			assert.deepEqual(JSON.parse(String(init?.body)), batch);
			return Response.json({ schemaVersion: 1, accepted: 0, duplicates: 1 });
		},
	});
	assert.deepEqual(await exporter.export(batch), { schemaVersion: 1, accepted: 0, duplicates: 1 });
});

test('trace endpoint refuses remote, credentialed, query, fragment, and non-ingestion URLs', () => {
	for (const endpoint of [
		'https://localhost:43199', 'http://example.com', 'http://127.0.0.1.example.com',
		'http://writer:secret@localhost', 'http://@localhost', 'http://localhost?token=secret',
		'http://localhost#fragment', 'http://localhost?', 'http://localhost/v1/sessions',
	]) {
		assert.throws(() => new HttpTraceExporter({ token: 'writer', endpoint }));
	}
	assert.throws(() => new HttpTraceExporter({ token: '' }));
});

test('trace HTTP exporter rejects invalid acknowledgements without exposing response bodies', async () => {
	for (const response of [
		Response.json({ schemaVersion: 1, accepted: 0, duplicates: 0 }),
		Response.json({ schemaVersion: 1, accepted: 1, duplicates: 0, secret: 'raw-secret' }),
		Response.json({ schemaVersion: 1, accepted: -1, duplicates: 2 }),
		new Response('raw-secret'), new Response('x'.repeat(16_385)),
	]) {
		const exporter = new HttpTraceExporter({ token: 'writer', fetchImpl: async () => response });
		await assert.rejects(exporter.export(batch), (error) => error instanceof TraceExportError && error.code === 'ack' && !error.message.includes('raw-secret'));
	}
});

test('trace HTTP exporter rejects unauthorized and redirect responses and classifies retryable failures', async () => {
	for (const statusCode of [401, 403, 302, 307, 408, 429, 503]) {
		const exporter = new HttpTraceExporter({
			token: 'writer', fetchImpl: async () => new Response('raw-secret', { status: statusCode, headers: { location: 'http://example.com' } }),
		});
		await assert.rejects(exporter.export(batch), (error) => error instanceof TraceExportError
			&& error.statusCode === statusCode && error.retryable === [408, 429, 503].includes(statusCode));
	}
	const exporter = new HttpTraceExporter({ token: 'writer', fetchImpl: async () => { throw new Error('raw-secret'); } });
	await assert.rejects(exporter.export(batch), (error) => error instanceof TraceExportError && error.retryable && !error.message.includes('raw-secret'));
});

test('native fetch sends the writer credential to the collector and never follows a redirect', async () => {
	let responseStatus = 200;
	let redirectedRequests = 0;
	const tokens: unknown[] = [];
	const bodies: string[] = [];
	const server = createServer((request, response) => {
		if (request.url === '/redirect-target') { redirectedRequests += 1; }
		tokens.push(request.headers['x-model-worklog-token']);
		let body = '';
		request.setEncoding('utf8');
		request.on('data', (chunk: string) => { body += chunk; });
		request.on('end', () => {
			bodies.push(body);
			response.writeHead(responseStatus, { 'content-type': 'application/json', location: '/redirect-target' });
			response.end(JSON.stringify({ schemaVersion: 1, accepted: 1, duplicates: 0 }));
		});
	});
	await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
	try {
		const address = server.address();
		assert.ok(address !== null && typeof address !== 'string');
		const exporter = new HttpTraceExporter({ endpoint: `http://127.0.0.1:${address.port}`, token: 'dedicated-writer' });
		assert.deepEqual(await exporter.export(batch), { schemaVersion: 1, accepted: 1, duplicates: 0 });
		responseStatus = 401;
		await assert.rejects(exporter.export(batch), (error) => error instanceof TraceExportError && error.statusCode === 401);
		responseStatus = 307;
		await assert.rejects(exporter.export(batch), TraceExportError);
		assert.equal(redirectedRequests, 0);
		assert.deepEqual(tokens, ['dedicated-writer', 'dedicated-writer', 'dedicated-writer']);
		for (const body of bodies) { assert.deepEqual(JSON.parse(body) as unknown, batch); }
	} finally { await new Promise<void>((resolve, reject) => { server.close((error) => { if (error !== undefined) { reject(error); } else { resolve(); } }); }); }
});