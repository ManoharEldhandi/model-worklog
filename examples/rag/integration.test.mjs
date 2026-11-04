import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createModelLogger, HttpTraceExporter, LocalSupervisorClient } from '../../packages/adapter-sdk/dist/index.js';
import { ChromaLogVectorStore, CollectorLogSource, HttpLogRagReranker, LogRag, LogRagTraceExporter, OpenAiLogEmbedder } from '../../packages/adapter-sdk/dist/rag/index.js';
import { createTraceCredential, startSupervisor } from '../../apps/local-supervisor/dist/index.js';

test('SDK capture → Chroma + embeddings → hybrid query → cited answer → scoped import → retention sync', { timeout: 120_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'sdk-rag-integration-'));
	const collector = await startSupervisor({ dataDirectory: directory, port: 0, tracePrivacy: { mode: 'redacted-content' } });
	try {
		const projectId = 'sdk-integration';
		const reader = await createTraceCredential({ url: collector.url, adminToken: collector.authToken, role: 'reader', projects: [projectId] });
		const writer = await createTraceCredential({ url: collector.url, adminToken: collector.authToken, role: 'writer', projects: [projectId] });
		const embedder = new OpenAiLogEmbedder({ endpoint: process.env.MODEL_WORKLOG_EMBEDDING_URL ?? 'http://127.0.0.1:18562/v1/embeddings', model: process.env.MODEL_WORKLOG_EMBEDDING_MODEL ?? 'BAAI/bge-small-en-v1.5', queryPrefix: 'query: ', documentPrefix: 'passage: ' });
		const collection = `sdk-integration-${randomUUID()}`;
		const options = { embedder, store: new ChromaLogVectorStore({ url: process.env.MODEL_WORKLOG_CHROMA_URL ?? 'http://127.0.0.1:18561', collection }),
			reranker: new HttpLogRagReranker(process.env.MODEL_WORKLOG_RERANK_URL ?? 'http://127.0.0.1:18563/v1/rerank'), minRerankScore: .0001, rerankVectorWeight: .75 };
		const rag = new LogRag(options);
		const exporter = new LogRagTraceExporter(rag, new HttpTraceExporter({ endpoint: collector.url, token: writer.token }));
		const logger = createModelLogger({ projectId, serviceName: 'payments-example', exporter, privacy: { mode: 'redacted-content' }, exportTimeoutMs: 30_000 });
		let traceId;
		await logger.trace({ name: 'payment.review', kind: 'agent', input: { task: 'Investigate a declined refund.' } }, async (root) => {
			traceId = root.context.traceId;
			try {
				await logger.trace({ name: 'payment.refund', kind: 'tool', input: { paymentAgeDays: 190 } }, (span) => {
					span.setAttribute('error.message', 'Refund rejected because the original payment was settled 190 days ago; the refund window is 180 days. token=private-example-secret');
					throw new Error('Refund window expired.');
				});
			} catch { /* Handled application failure remains an observable failed tool. */ }
			await logger.trace({ name: 'read_file', kind: 'tool', input: { path: 'services/payments/refunds.ts' }, serializeResult: (value) => value }, () => 'Refunds are allowed within 180 days of settlement.');
		});
		assert.equal((await logger.shutdown()).success, true);
		const result = await rag.ask({ projectId, traceId, question: 'Why could the customer not get their money back?', limit: 5 });
		assert.ok(result.hits.some((hit) => hit.chunk.text.includes('180')));
		assert.ok(result.hits.some((hit) => hit.chunk.source.state === 'failed'));
		assert.match(result.answer, /\[S[1-9]/);
		assert.doesNotMatch(JSON.stringify(result), /private-example-secret/);
		assert.equal(result.aggregates.toolCalls, 2);
		assert.equal((await rag.search({ projectId: 'other', question: 'refund' })).hits.length, 0);
		const client = new LocalSupervisorClient({ supervisorUrl: collector.url, token: reader.token });
		assert.equal((await client.askLogs({ projectId, traceId, question: 'What tools were used?' })).totals.toolCalls, 2);
		const source = new CollectorLogSource(client);
		const synced = await rag.sync(source, { projectId, traceId }, { prune: true });
		assert.equal(synced.complete, true);
		const denied = new CollectorLogSource(new LocalSupervisorClient({ supervisorUrl: collector.url, token: writer.token }));
		await assert.rejects(denied.load({ projectId }, AbortSignal.timeout(5000)), { statusCode: 403 });
		const deleted = await fetch(new URL(`/v2/traces/${traceId}?projectId=${projectId}`, collector.url), { method: 'DELETE', headers: { 'x-model-worklog-token': collector.authToken } });
		assert.equal(deleted.status, 200);
		await rag.sync(source, { projectId }, { prune: true });
		assert.equal((await rag.search({ projectId, question: 'refund' })).hits.length, 0);
	} finally { await collector.close(); await rm(directory, { recursive: true, force: true }); }
});
