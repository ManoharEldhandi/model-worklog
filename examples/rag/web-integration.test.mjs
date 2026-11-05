import assert from 'node:assert/strict';
import test from 'node:test';
import { startWebDashboard } from '../web-dashboard/server.mjs';
import { workspaceRelay } from '../web-dashboard/fixtures/workspaceRelay.mjs';

test('workspace chat → real file reads and failing tests → SDK hybrid retrieval → cited log answer', { timeout: 120_000 }, async () => {
	const dashboard = await startWebDashboard({ provider: 'codex', codexRelayFactory: workspaceRelay, logAnswerGenerator: {
		provider: 'test-model', async generate(_question, evidence) {
			assert.equal(evidence.retrieval.strategy, 'chroma-hybrid'); assert.equal(evidence.retrieval.semantic.degraded, false);
			const source = evidence.evidence.find((source) => /negative quantit/i.test(source.excerpt)); assert.ok(source);
			return { answer: `The negative quantity regression failed: quotedPrice accepted a negative quantity instead of rejecting it. [${source.id}]`, sourceIds: [source.id] };
		},
	} });
	try {
		const post = async (path, body) => { const response = await fetch(new URL(path, dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(response.ok); return response.json(); };
		const { runId } = await post('/api/chat', { message: 'Read pricing.ts and run the tests.' });
		let run;
		for (let attempt = 0; attempt < 100; attempt++) { run = await fetch(new URL(`/api/runs/${runId}`, dashboard.url)).then((response) => response.json()); if (run.status !== 'running') { break; } await new Promise((resolve) => setTimeout(resolve, 50)); }
		assert.equal(run.status, 'completed');
		assert.ok(run.activity.entries.some((entry) => entry.status === 'failed'));
		const first = await post('/api/logs/query', { traceId: run.traceId, question: 'Which test failed and why?', synthesis: 'model' });
		assert.equal(first.generation.status, 'generated'); assert.match(first.answer, /negative quantity/);
		assert.ok(first.evidence.some((source) => source.serviceName.startsWith('codex-')));
		const count = await post('/api/logs/query', { traceId: run.traceId, question: 'How many times was read_file used?', intent: 'tools' });
		assert.equal(count.totals.toolCalls, 2);
		const download = await fetch(new URL(`/api/runs/${runId}/download`, dashboard.url)).then((r) => r.json());
		assert.match(JSON.stringify(download.storedSpans), /negative quantities must be rejected/);
	} finally { await dashboard.close(); }
});
