import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const python = process.env.MODEL_WORKLOG_RAG_PYTHON ?? join(root, '.venv-rag', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const temporary = await mkdtemp(join(tmpdir(), 'model-worklog-rag-live-'));
const cache = process.env.MODEL_WORKLOG_MODEL_CACHE ?? join(homedir(), '.cache', 'model-worklog', 'models');
await mkdir(join(root, 'output/rag'), { recursive: true });
await mkdir(cache, { recursive: true });
const children = []; const logs = new Map();
async function port() { const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const selected = server.address().port; await new Promise((resolve) => server.close(resolve)); return selected; }
function service(name, args) {
	const child = spawn(python, args, { cwd: root, env: { ...process.env, ANONYMIZED_TELEMETRY: 'False' }, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(child); logs.set(name, '');
	const capture = (data) => logs.set(name, (logs.get(name) + String(data)).slice(-20000)); child.stdout.on('data', capture); child.stderr.on('data', capture);
	child.on('error', (error) => { child.startupError = error; capture(error.message); }); return child;
}
async function ready(url, child) {
	const deadline = Date.now() + 180_000;
	while (Date.now() < deadline) {
		if (child.startupError || child.exitCode !== null || child.signalCode !== null) { throw new Error('A local RAG service could not start. Install examples/rag/requirements.txt into .venv-rag or set MODEL_WORKLOG_RAG_PYTHON. See output/rag service logs.'); }
		try { const response = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (response.ok) { await response.body?.cancel(); return; } } catch { /* Wait for explicit local model download/warmup. */ }
		await delay(500);
	}
	throw new Error('Local RAG service startup exceeded three minutes. See output/rag service logs.');
}
async function command(args, env) {
	console.log(`Running ${args.join(' ')}`);
	const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit' });
	children.push(child);
	await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`RAG check failed with exit code ${code}.`))); });
}
try {
	const chromaPort = await port(); const embeddingPort = await port();
	const chroma = service('chroma', ['-c', 'from chromadb.cli.cli import app; app()', 'run', '--host', '127.0.0.1', '--port', String(chromaPort), '--path', join(temporary, 'chroma')]);
	const embedding = service('models', ['examples/rag/local_embeddings.py', '--port', String(embeddingPort), '--cache-dir', cache, '--reranker']);
	console.log('Starting isolated Chroma and local ONNX models; first use downloads weights.');
	await ready(`http://127.0.0.1:${chromaPort}/api/v2/heartbeat`, chroma);
	await ready(`http://127.0.0.1:${embeddingPort}/health`, embedding);
	const env = { MODEL_WORKLOG_TEST_CHROMA_URL: `http://127.0.0.1:${chromaPort}`, MODEL_WORKLOG_CHROMA_URL: `http://127.0.0.1:${chromaPort}`,
		MODEL_WORKLOG_EMBEDDING_URL: `http://127.0.0.1:${embeddingPort}/v1/embeddings`, MODEL_WORKLOG_EMBEDDING_MODEL: 'BAAI/bge-small-en-v1.5',
		MODEL_WORKLOG_RERANK_URL: `http://127.0.0.1:${embeddingPort}/v1/rerank`, MODEL_WORKLOG_RERANK_MODEL: 'ms-marco-MiniLM-L-12-v2',
		MODEL_WORKLOG_MIN_RERANK_SCORE: '0.0001', MODEL_WORKLOG_RERANK_VECTOR_WEIGHT: '0.75', MODEL_WORKLOG_HNSW_EF_SEARCH: '128',
		MODEL_WORKLOG_EVAL_MODES: 'bm25,vector,hybrid,hybridReranked', MODEL_WORKLOG_RAG_REPORT: 'output/rag/evaluation.json' };
	await command(['--test', 'packages/adapter-sdk/test-dist/rag/*.test.js', 'examples/rag/evaluation/metrics.test.mjs', 'examples/rag/integration.test.mjs'], env);
	await command(['examples/rag/evaluation/run.mjs', '--check'], env);
	await command(['examples/rag/evaluation/ann.mjs', '--check'], env);
	console.log('All SDK RAG integration, retrieval-quality and ANN checks passed.');
} finally {
	for (const child of children) { if (child.exitCode === null) { child.kill('SIGTERM'); } }
	await Promise.all(children.map((child) => child.exitCode !== null ? Promise.resolve() : new Promise((resolve) => { const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000); child.once('exit', () => { clearTimeout(timeout); resolve(); }); })));
	for (const [name, value] of logs) { await writeFile(join(root, 'output/rag', `${name}.log`), value); }
	await rm(temporary, { recursive: true, force: true });
}
