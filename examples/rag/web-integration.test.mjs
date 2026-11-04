import assert from 'node:assert/strict';
import test from 'node:test';
import { startWebDashboard } from '../web-dashboard/server.mjs';

test('browser API imports captured refund logs into real SDK RAG and distinguishes missing amounts', { timeout: 120_000 }, async () => {
	const seen = [];
	const dashboard = await startWebDashboard({ provider: 'offline-demo', logAnswerGenerator: {
		provider: 'test-model', async generate(question, evidence) {
			seen.push(evidence); assert.equal(evidence.retrieval.strategy, 'chroma-hybrid');
			assert.equal(evidence.retrieval.semantic.degraded, false);
			const source = evidence.evidence.find((source) => source.excerpt.includes('180')) ?? evidence.evidence[0];
			return { answer: /amount/i.test(question) ? `The refund amount wasn't recorded in these logs. [${source.id}]` : `The refund failed because the payment was 190 days old, beyond the 180-day window. [${source.id}]`, sourceIds: [source.id] };
		},
	} });
	try {
		const post = async (path, body) => { const response = await fetch(new URL(path, dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(response.ok); return response.json(); };
		const { runId } = await post('/api/logs/sample', { scenario: 'refund' });
		let run;
		for (let attempt = 0; attempt < 100; attempt++) { run = await fetch(new URL(`/api/runs/${runId}`, dashboard.url)).then((response) => response.json()); if (run.status !== 'running') { break; } await new Promise((resolve) => setTimeout(resolve, 50)); }
		assert.equal(run.status, 'completed');
		const first = await post('/api/logs/query', { traceId: run.traceId, question: 'Why did the refund fail?', synthesis: 'model' });
		assert.equal(first.generation.status, 'generated'); assert.match(first.answer, /190 days old/); assert.equal(first.totals.toolCalls, 1);
		assert.ok(first.evidence.every((source) => source.serviceName === 'refund-sample'));
		const amount = await post('/api/logs/query', { traceId: run.traceId, question: 'What is the amount?', synthesis: 'model', history: [{ role: 'user', content: 'Why did the refund fail?' }, { role: 'assistant', content: first.answer }] });
		assert.match(amount.answer, /wasn't recorded/); assert.doesNotMatch(amount.answer, /190|ageDays|attributes:/);
		const local = await post('/api/logs/query', { traceId: run.traceId, question: 'What is the amount?' });
		assert.match(local.answer, /amount.*wasn't recorded/i); assert.equal(local.retrieval.semantic.indexedSpans, 2);
		assert.equal(seen.length, 2);
	} finally { await dashboard.close(); }
});
