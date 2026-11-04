import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { OpenAiLogEmbedder } from './embedding';
import { OpenAiLogRagAnswerer } from './answerer';
import type { LogRagSearchResult } from './types';

test('HTTP embedding adapters reject unsafe endpoints and malformed vectors, and preserve response index order', async (context) => {
	for (const endpoint of ['http://remote.example/embeddings', 'https://user:secret@example.com/embeddings', 'https://example.com/?key=secret']) { assert.throws(() => new OpenAiLogEmbedder({ endpoint, model: 'test' })); }
	let malformed = false;
	const server = createServer((request, response) => {
		request.resume(); request.on('end', () => response.end(JSON.stringify({ data: malformed ? [{ index: 0, embedding: [0, 0] }] : [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })));
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); context.after(() => { server.closeAllConnections(); server.close(); });
	const address = server.address(); assert.ok(address && typeof address !== 'string');
	const provider = new OpenAiLogEmbedder({ endpoint: `http://127.0.0.1:${address.port}/v1/embeddings`, model: 'test' });
	assert.deepEqual(await provider.embed(['first', 'second'], AbortSignal.timeout(2000)), [[1, 0], [0, 1]]);
	malformed = true; await assert.rejects(provider.embed(['first', 'second'], AbortSignal.timeout(2000)));
});

test('HTTP answer generation sends bounded untrusted evidence without tools and accepts structured citations', async (context) => {
	const server = createServer((request, response) => {
		const chunks: Buffer[] = []; request.on('data', (chunk: Buffer) => chunks.push(chunk)); request.on('end', () => {
			const body = JSON.parse(Buffer.concat(chunks).toString());
			assert.match(body.messages[0].content, /untrusted/);
			assert.equal(body.tools, undefined);
			assert.equal(body.model, 'test');
			response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ answer: 'No indexed records were available.', sourceIds: [] }) } }] }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve)); context.after(() => { server.closeAllConnections(); server.close(); });
	const address = server.address(); assert.ok(address && typeof address !== 'string');
	const provider = new OpenAiLogRagAnswerer({ endpoint: `http://127.0.0.1:${address.port}/v1/chat/completions`, model: 'test' });
	const result: LogRagSearchResult = { question: 'What happened?', scope: { projectId: 'app' }, hits: [], mode: 'hybrid', degraded: false, snapshotAt: new Date().toISOString(), aggregates: { spans: 0, toolCalls: 0, failedSpans: 0, complete: true }, coverage: { indexedSpans: 0, indexedChunks: 0, truncated: false, shortenedSpans: 0 }, limitations: [], timings: { totalMs: 0, embeddingMs: 0, vectorMs: 0, lexicalMs: 0 } };
	assert.equal((await provider.answer('What happened?', result, [], AbortSignal.timeout(2000))).sourceIds.length, 0);
});
