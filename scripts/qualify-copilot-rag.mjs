import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { CopilotLogAnswerGenerator } from '../apps/local-supervisor/dist/index.js';
import { startWebDashboard } from '../examples/web-dashboard/server.mjs';

// Explicit, opt-in live qualification. Uses only the checked-in sample workload.
const dashboard = await startWebDashboard({ provider: 'offline-demo', logAnswerGenerator: new CopilotLogAnswerGenerator() });
try {
	const post = (path, body) => fetch(new URL(path, dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) }).then(async (response) => {
		assert.equal(response.status, path === '/api/logs/sample' ? 202 : 200);
		return response.json();
	});
	const { runId } = await post('/api/logs/sample', {});
	let run;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		run = await fetch(new URL(`/api/runs/${runId}`, dashboard.url)).then((response) => response.json());
		if (run.status !== 'running') { break; }
		await delay(100);
	}
	assert.equal(run.status, 'completed', 'The sample capture must complete.');
	const question = 'How many times was read_file used?';
	const first = await post('/api/logs/query', { question, traceId: run.traceId, synthesis: 'model' });
	assert.equal(first.generation.status, 'generated', 'The installed Copilot CLI must generate an answer, without an evidence fallback. Check Copilot authentication and supported restrictions.');
	assert.equal(first.totals.toolCalls, 120);
	assert.match(first.answer, /\[A1\]/);
	console.log('PASS: real Copilot answered exact scoped tool counts with aggregate citations.');
	const second = await post('/api/logs/query', { question: 'What failed in this run?', traceId: run.traceId, synthesis: 'model', history: [{ role: 'user', content: question }, { role: 'assistant', content: first.answer.slice(0, 4_000) }] });
	assert.equal(second.generation.status, 'generated', 'The follow-up must be model-generated.');
	assert.ok(second.evidence.some((source) => source.name === 'validate_stock' && source.state === 'failed'));
	assert.match(second.answer, /\[S[1-9][0-9]*\]/);
	console.log('PASS: real Copilot answered a follow-up from freshly retrieved failure evidence.');
} finally { await dashboard.close(); }
