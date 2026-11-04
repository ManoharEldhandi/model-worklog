import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createInterface } from 'node:readline/promises';
import { appendLogHistory } from 'model-worklog-schema';
import { ChromaLogVectorStore, HttpLogRagReranker, LogRag, OpenAiLogEmbedder } from 'model-worklog-sdk/rag';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const python = process.env.MODEL_WORKLOG_RAG_PYTHON ?? join(root, '.venv-rag/bin/python');
const cache = process.env.MODEL_WORKLOG_MODEL_CACHE ?? join(homedir(), '.cache/model-worklog/models');
const temporary = await mkdtemp(join(tmpdir(), 'model-worklog-rag-demo-'));
const cancellation = new AbortController(); const { signal } = cancellation;
const children = []; const logs = new Map(); let stopping = false;
const interrupt = () => cancellation.abort(new DOMException('Demo stopped.', 'AbortError'));
process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);

async function availablePort() {
	const server = createServer();
	await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}
function service(name, args) {
	const child = spawn(python, args, { cwd: root, env: { ...process.env, ANONYMIZED_TELEMETRY: 'False' }, stdio: ['ignore', 'pipe', 'pipe'] });
	children.push(child); logs.set(name, '');
	const capture = (data) => logs.set(name, (logs.get(name) + String(data)).slice(-20000));
	child.stdout.on('data', capture); child.stderr.on('data', capture);
	child.on('error', (error) => { child.startupError = error; capture(error.message); cancellation.abort(new Error(`Could not start ${name}. See output/rag/demo-${name}.log.`)); });
	child.on('exit', () => { if (!stopping && !signal.aborted) { cancellation.abort(new Error(`${name} stopped unexpectedly. See output/rag/demo-${name}.log.`)); } });
	return child;
}
async function ready(url) {
	const startup = AbortSignal.any([signal, AbortSignal.timeout(600_000)]);
	while (!startup.aborted) {
		try {
			const response = await fetch(url, { signal: AbortSignal.any([startup, AbortSignal.timeout(2000)]) });
			await response.body?.cancel(); if (response.ok) { return; }
		} catch { startup.throwIfAborted(); }
		await delay(500, undefined, { signal: startup });
	}
	startup.throwIfAborted();
}
async function recordSample(env) {
	const child = spawn(process.execPath, ['examples/rag/quickstart.mjs'], { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', signal });
	children.push(child);
	await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => code === 0 ? resolve() : reject(new Error('The SDK sample did not finish. See the delivery diagnostics above.'))); });
}
async function chat(env) {
	const rag = new LogRag({
		store: new ChromaLogVectorStore({ url: env.MODEL_WORKLOG_CHROMA_URL, collection: 'my-agent-logs' }),
		embedder: new OpenAiLogEmbedder({ endpoint: env.MODEL_WORKLOG_EMBEDDING_URL, model: 'BAAI/bge-small-en-v1.5', queryPrefix: 'query: ', documentPrefix: 'passage: ' }),
		reranker: new HttpLogRagReranker(env.MODEL_WORKLOG_RERANK_URL),
	});
	const terminal = createInterface({ input: process.stdin, output: process.stdout });
	terminal.on('SIGINT', interrupt);
	let history = [];
	console.log('\nAsk about the sample logs. Try "Why did the refund fail?" or "What was the refund window?"');
	console.log('Answers are local source excerpts with citations. Type exit or press Ctrl+C to stop.\n');
	try {
		for (;;) {
			const question = (await terminal.question('Ask logs> ', { signal })).trim();
			if (/^(exit|quit|q)$/i.test(question)) { break; } if (!question) { continue; }
			try {
				const result = await rag.ask({ projectId: 'payments', question, history, signal });
				console.log(`\n${result.answer}\n`);
				if (result.degraded) { console.log('Retrieval is degraded; inspect the returned limitations.'); }
				history = appendLogHistory(history, question, result.answer);
			} catch (error) { signal.throwIfAborted(); console.error(`Query failed: ${error.message}`); }
		}
	} finally { terminal.close(); }
}

try {
	await mkdir(cache, { recursive: true }); await mkdir(join(root, 'output/rag'), { recursive: true });
	const chromaPort = await availablePort(); const modelPort = await availablePort();
	console.log('Starting isolated Chroma and CPU models. First use downloads weights; later runs reuse the cache.');
	service('chroma', ['-c', 'from chromadb.cli.cli import app; app()', 'run', '--host', '127.0.0.1', '--port', String(chromaPort), '--path', join(temporary, 'chroma')]);
	service('models', ['examples/rag/local_embeddings.py', '--port', String(modelPort), '--cache-dir', cache, '--reranker']);
	await ready(`http://127.0.0.1:${chromaPort}/api/v2/heartbeat`);
	await ready(`http://127.0.0.1:${modelPort}/health`);
	const env = { MODEL_WORKLOG_CHROMA_URL: `http://127.0.0.1:${chromaPort}`, MODEL_WORKLOG_EMBEDDING_URL: `http://127.0.0.1:${modelPort}/v1/embeddings`, MODEL_WORKLOG_RERANK_URL: `http://127.0.0.1:${modelPort}/v1/rerank` };
	console.log(`Chroma: ${env.MODEL_WORKLOG_CHROMA_URL}\nEmbeddings: ${env.MODEL_WORKLOG_EMBEDDING_URL}`);
	console.log('\nRecording a refund failure through the SDK and retrieving a cited answer:\n');
	await recordSample(env);
	if (process.argv[2] !== '--no-chat' && process.stdin.isTTY && process.stdout.isTTY) { await chat(env); }
} catch (error) {
	if (signal.reason?.name !== 'AbortError') { console.error(signal.aborted ? signal.reason.message : error.message); }
	process.exitCode = signal.reason?.name === 'AbortError' ? 130 : 1;
} finally {
	stopping = true;
	await Promise.all(children.map(async (child) => {
		if (child.exitCode !== null || child.signalCode !== null || child.startupError) { return; }
		await new Promise((resolve) => {
			const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
			child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
		});
	}));
	await mkdir(join(root, 'output/rag'), { recursive: true });
	for (const [name, output] of logs) { await writeFile(join(root, 'output/rag', `demo-${name}.log`), output); }
	await rm(temporary, { recursive: true, force: true });
	process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
	console.log('Demo stopped; temporary log data removed. Downloaded models are cached for the next run.');
}
