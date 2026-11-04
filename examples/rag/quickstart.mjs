import { createModelLogger } from '../../packages/adapter-sdk/dist/index.js';
import { ChromaLogVectorStore, HttpLogRagReranker, LogRag, LogRagTraceExporter, OpenAiLogEmbedder } from '../../packages/adapter-sdk/dist/rag/index.js';

const rag = new LogRag({
	store: new ChromaLogVectorStore({ url: process.env.MODEL_WORKLOG_CHROMA_URL ?? 'http://127.0.0.1:18561', collection: 'my-agent-logs' }),
	embedder: new OpenAiLogEmbedder({ endpoint: process.env.MODEL_WORKLOG_EMBEDDING_URL ?? 'http://127.0.0.1:18562/v1/embeddings', model: 'BAAI/bge-small-en-v1.5', queryPrefix: 'query: ', documentPrefix: 'passage: ' }),
	reranker: new HttpLogRagReranker(process.env.MODEL_WORKLOG_RERANK_URL ?? 'http://127.0.0.1:18563/v1/rerank'),
	minRerankScore: .0001, rerankRecallFloor: .8, rerankVectorWeight: .75,
});
const logger = createModelLogger({ projectId: 'payments', serviceName: 'refund-worker', privacy: { mode: 'redacted-content' }, exporter: new LogRagTraceExporter(rag), exportTimeoutMs: 30_000 });
try {
	await logger.trace({ name: 'payment.refund', kind: 'tool', input: { ageDays: 190 } }, (span) => {
		span.setAttribute('error.message', 'The refund window is 180 days; this payment was settled 190 days ago.');
		throw new Error('Refund window expired.');
	});
} catch { /* Preserve the application failure; logging does not invent a successful refund. */ }
const delivery = await logger.shutdown();
if (!delivery.success) { throw new Error('RAG indexing did not finish. Check local services and delivery diagnostics.'); }
const answer = await rag.ask({ projectId: 'payments', question: 'Why could the customer not get their money back?' });
console.log(answer.answer);
console.log(JSON.stringify({ generation: answer.generation, coverage: answer.coverage }, null, 2));
