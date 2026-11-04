import { mkdir, writeFile } from 'node:fs/promises';
import { ChromaLogVectorStore, HttpLogRagReranker, LogRag, OpenAiLogEmbedder } from '../../../packages/adapter-sdk/dist/rag/index.js';
import { corpus, development, heldOut, absent, stored } from './fixtures.mjs';
import { metrics } from './metrics.mjs';

const embeddingUrl = process.env.MODEL_WORKLOG_EMBEDDING_URL ?? 'http://127.0.0.1:18562/v1/embeddings';
const model = process.env.MODEL_WORKLOG_EMBEDDING_MODEL ?? 'BAAI/bge-small-en-v1.5';
const embedder = new OpenAiLogEmbedder({ endpoint: embeddingUrl, model, queryPrefix: 'query: ', documentPrefix: 'passage: ' });
const store = new ChromaLogVectorStore({ url: process.env.MODEL_WORKLOG_CHROMA_URL ?? 'http://127.0.0.1:18561', collection: `model-worklog-evaluation-v2-${embedder.id.slice(0, 12)}` });
const rag = new LogRag({ store, embedder, minSimilarity: .25, candidates: 100 });
const rerankModel = process.env.MODEL_WORKLOG_RERANK_MODEL ?? 'ms-marco-MiniLM-L-12-v2';
const reranked = new LogRag({ store, embedder, minSimilarity: .25, candidates: 100, minRerankScore: Number(process.env.MODEL_WORKLOG_MIN_RERANK_SCORE ?? .0001), rerankRecallFloor: .8, rerankVectorWeight: Number(process.env.MODEL_WORKLOG_RERANK_VECTOR_WEIGHT ?? .75), reranker: new HttpLogRagReranker(process.env.MODEL_WORKLOG_RERANK_URL ?? 'http://127.0.0.1:18563/v1/rerank', rerankModel) });
const started = performance.now();
await rag.indexSpans([...corpus.map((item) => stored(item)), stored({ ...corpus[0], text: 'Private cross-project refund details.' }, 'other-project')]);
const indexMs = performance.now() - started;
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), model, rerankModel, corpusSpans: corpus.length, indexMs, hnsw: (await store.describe(AbortSignal.timeout(5000))).hnsw,
	definition: 'Source-level metrics after deduplicating span IDs. Every labelled query has one relevant source, so maximum precision@3=1/3 and precision@5=1/5.', development: {}, heldOut: {}, absent: [] };
for (const [split, questions] of [['development', development], ['heldOut', heldOut]]) {
	for (const mode of (process.env.MODEL_WORKLOG_EVAL_MODES ?? 'bm25,vector,hybrid,hybridReranked').split(',')) {
		const cases = [];
		for (const question of questions) {
			const response = await (mode === 'hybridReranked' ? reranked : rag).search({ projectId: 'evaluation', question: question.question, mode: mode === 'hybridReranked' ? 'hybrid' : mode, limit: 20 });
			if (response.hits.some((hit) => hit.chunk.source.projectId !== 'evaluation') || response.degraded || response.coverage.truncated) { throw new Error('Evaluation scope leak, partial corpus or provider fallback.'); }
			const retrieved = [...new Set(response.hits.map((hit) => corpus.find((item) => item.spanId === hit.chunk.source.spanId)?.id).filter(Boolean))];
			cases.push({ ...question, retrieved, latencyMs: response.timings.totalMs, topSimilarity: response.hits[0]?.similarity ?? null, topRelevance: response.hits[0]?.relevance ?? null });
		}
		const latencies = cases.map((item) => item.latencyMs).sort((a, b) => a - b);
		report[split][mode] = { metrics: metrics(cases), latency: { p50Ms: latencies[Math.floor(latencies.length * .5)], p95Ms: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * .95))] }, cases };
		console.log(`${split} ${mode}: ${JSON.stringify(report[split][mode].metrics)}`);
	}
}
for (const question of absent) { const result = await reranked.search({ projectId: 'evaluation', question, mode: 'hybrid', limit: 3 }); report.absent.push({ question, returned: result.hits.length, topSimilarity: result.hits[0]?.similarity ?? null, relevance: result.hits[0]?.relevance ?? null }); }
const output = process.env.MODEL_WORKLOG_RAG_REPORT ?? 'output/rag/evaluation.json';
await mkdir(output.slice(0, output.lastIndexOf('/')) || '.', { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(`Evaluation report: ${output}`);
if (process.argv.includes('--check')) {
	const quality = report.heldOut.hybridReranked.metrics;
	if (quality.precisionAt1 < .95 || quality.recallAt3 < .99) { throw new Error('Hybrid retrieval did not meet precision@1 >= .95 and recall@3 >= .99.'); }
	if (report.absent.slice(0, 2).some((control) => control.returned !== 0)) { throw new Error('Unrelated-topic controls must return no relevant evidence.'); }
}
