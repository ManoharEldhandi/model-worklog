import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { LogQueryResponseSchema } from 'model-worklog-schema';

import { OpenAiLogAnswerGenerator } from './logAnswerGenerator';

const evidence = LogQueryResponseSchema.parse({
	schemaVersion: 1, intent: 'search', answer: 'local', scope: { projectId: 'project' }, snapshotAt: '2026-10-20T00:00:00.000Z',
	totals: { spans: 0, traces: 0, toolCalls: 0, failedSpans: 0, runningSpans: 0, metadataOnlySpans: 0, limitedSpans: 0 },
	tools: [], evidence: [], retrieval: { strategy: 'sqlite-fts5', matchedSpans: 0, returnedSpans: 0, truncated: false, toolsTruncated: false }, limitations: [],
});

test('answer provider requires secure explicit configuration', () => {
	for (const endpoint of ['http://remote.example/chat', 'https://user:password@example.com/chat', 'https://example.com/chat?api_key=secret', 'file:///tmp/model']) {
		assert.throws(() => new OpenAiLogAnswerGenerator({ endpoint, model: 'test' }));
	}
	assert.throws(() => new OpenAiLogAnswerGenerator({ endpoint: 'https://example.com/chat', model: '' }));
	assert.doesNotThrow(() => new OpenAiLogAnswerGenerator({ endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'local' }));
});

test('answer provider sends bounded untrusted evidence, accepts strict JSON, and rejects oversized output', async (context) => {
	let oversized = false;
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on('data', (chunk: Buffer) => chunks.push(chunk));
		request.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: { content: string }[]; max_tokens: number };
			assert.match(body.messages[0]!.content, /untrusted data/);
			assert.equal(body.max_tokens, 1500);
			assert.equal(request.headers.authorization, 'Bearer server-only-key');
			response.setHeader('content-type', 'application/json');
			response.end(oversized ? 'x'.repeat(65_537) : JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'Recorded detail [S1].', sourceIds: ['S1'] }) } }] }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	context.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
	const address = server.address();
	assert.ok(address !== null && typeof address !== 'string');
	const generator = new OpenAiLogAnswerGenerator({ endpoint: `http://127.0.0.1:${address.port}/chat`, model: 'local', apiKey: 'server-only-key' });
	assert.equal((await generator.generate('inventory', evidence, AbortSignal.timeout(2000))).answer, 'Recorded detail [S1].');
	oversized = true;
	await assert.rejects(generator.generate('inventory', evidence, AbortSignal.timeout(2000)), /safety limit/);
});
