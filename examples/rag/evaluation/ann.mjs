import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { ChromaClient } from 'chromadb';

const url = new URL(process.env.MODEL_WORKLOG_CHROMA_URL ?? 'http://127.0.0.1:18561');
const efSearch = Number(process.env.MODEL_WORKLOG_HNSW_EF_SEARCH ?? 128);
const client = new ChromaClient({ host: url.hostname, port: Number(url.port || 80), ssl: url.protocol === 'https:' });
const collection = await client.getOrCreateCollection({ name: 'model-worklog-ann-regression-v1', embeddingFunction: null,
	configuration: { hnsw: { space: 'cosine', ef_construction: 200, ef_search: efSearch, max_neighbors: 32 } } });
await collection.modify({ configuration: { hnsw: { ef_search: efSearch } } });
let seed = 73491;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
function vector() { const values = Array.from({ length: 384 }, () => random() * 2 - 1); const norm = Math.hypot(...values); return values.map((value) => value / norm); }
const vectors = Array.from({ length: 2048 }, vector); const ids = vectors.map((_vector, index) => `vector-${index}`);
for (let offset = 0; offset < vectors.length; offset += 128) { await collection.upsert({ ids: ids.slice(offset, offset + 128), embeddings: vectors.slice(offset, offset + 128) }); }
const recalls = []; const latencies = [];
for (let query = 0; query < 50; query += 1) {
	const embedding = vector();
	const exact = vectors.map((values, index) => ({ id: ids[index], score: values.reduce((sum, value, dimension) => sum + value * embedding[dimension], 0) })).sort((a, b) => b.score - a.score).slice(0, 10);
	const target = new Set(exact.map((item) => item.id)); const start = performance.now();
	const result = await collection.query({ queryEmbeddings: [embedding], nResults: 10, include: ['distances'] });
	latencies.push(performance.now() - start); recalls.push(result.ids[0].filter((id) => target.has(id)).length / 10);
}
latencies.sort((a, b) => a - b);
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), seed: 73491, corpusVectors: vectors.length, dimensions: 384, queries: recalls.length,
	metric: 'HNSW ANN recall@10 against exact brute-force cosine neighbours; synthetic vectors, separate from semantic relevance.',
	configuration: collection.configuration.hnsw, recallAt10: recalls.reduce((sum, value) => sum + value, 0) / recalls.length,
	minimumQueryRecallAt10: Math.min(...recalls), p50Ms: latencies[25], p95Ms: latencies[47] };
await mkdir('output/rag', { recursive: true }); await writeFile('output/rag/ann.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (process.argv.includes('--check')) { assert.ok(report.recallAt10 >= .95, 'HNSW recall@10 must reach .95 against the exact oracle.'); }
