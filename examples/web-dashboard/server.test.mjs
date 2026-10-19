import assert from 'node:assert/strict';
import test from 'node:test';

import { startWebDashboard } from './server.mjs';

async function waitForRun(baseUrl, runId) {
	for (let attempt = 0; attempt < 80; attempt += 1) {
		const response = await fetch(new URL(`/api/runs/${runId}`, baseUrl));
		assert.equal(response.status, 200);
		const run = await response.json();
		if (run.status !== 'running') {
			return run;
		}
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error('Dashboard run did not complete in time.');
}

test('web dashboard records a browser interaction as nested SDK spans', async (testContext) => {
	const dashboard = await startWebDashboard({ provider: 'offline-demo' });
	testContext.after(async () => dashboard.close());

	const page = await fetch(dashboard.url);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /Workspace review/);
	const logo = await fetch(new URL('/logo.png', dashboard.url));
	assert.equal(logo.status, 200);
	assert.match(logo.headers.get('content-type'), /image\/png/);
	const config = await fetch(new URL('/api/config', dashboard.url)).then((response) => response.json());
	assert.deepEqual(config.workspace.files, ['README.md', 'src/inventory.ts', 'src/pricing.ts']);

	const started = await fetch(new URL('/api/chat', dashboard.url), {
		body: JSON.stringify({ message: 'Show the browser trace for this request.' }),
		headers: { 'content-type': 'application/json' },
		method: 'POST',
	});
	assert.equal(started.status, 202);
	const { runId } = await started.json();
	const run = await waitForRun(dashboard.url, runId);

	assert.equal(run.status, 'completed');
	assert.equal(run.delivery, true);
	assert.equal(run.activity.schemaVersion, 1);
	assert.equal(run.activity.entries.filter((entry) => entry.category === 'tool').length, 0);
	assert.equal(run.activity.entries.some((entry) => entry.category === 'lifecycle'), false);
	assert.equal(run.activity.entries.find((entry) => entry.category === 'usage').title, 'Token usage not reported');
	assert.ok(run.activity.entries.every((entry) => entry.startedAt && entry.sources.length > 0));
	assert.equal(run.trace.spanCount, 2);
	assert.deepEqual(run.trace.spans.map((span) => span.name), [
		'website.chat',
		'model.chat.completions',
	]);

	const download = await fetch(new URL(`/api/runs/${runId}/download`, dashboard.url));
	assert.equal(download.status, 200);
	assert.match(download.headers.get('content-disposition') ?? '', /attachment; filename="model-worklog-run-/);
	const exported = await download.json();
	assert.equal(exported.schemaVersion, 1);
	assert.equal(exported.interaction.message, 'Show the browser trace for this request.');
	assert.equal(exported.run.trace.spanCount, 2);
	assert.equal(exported.metadata.activitySchemaVersion, 1);
	assert.equal(exported.metadata.underlyingExecutionComplete, false);
	assert.equal(exported.sourceEvents.length, run.activity.sourceCount);
	assert.equal(exported.storedSpans.length, 2);
	assert.equal('token' in exported, false);
});

test('dashboard groups native read lifecycles and retains MCP results and their raw source references', async (testContext) => {
	const dashboard = await startWebDashboard({ provider: 'copilot', copilotRelayFactory: (sink, options, onFinished) => ({
		async start() {
			for (let index = 0; index < 100; index += 1) {
				const correlationId = `read_${index}`;
				const base = { actor: 'copilot-cli', evidenceGrade: 'observed-native', correlationId };
				await sink.append({ ...base, kind: 'tool.called', payload: { tool: 'read_file', arguments: { path: `src/${index}.ts` } } });
				await sink.append({ ...base, kind: 'file.read', payload: { path: `src/${index}.ts`, tool: 'read_file' } });
				await sink.append({ ...base, kind: 'tool.completed', payload: { tool: 'read_file', success: true, result: { linesRead: 10 } } });
			}
			await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', correlationId: 'mcp', kind: 'tool.called', payload: { tool: 'search', server: 'docs', arguments: { query: 'inventory' } } });
			await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', correlationId: 'mcp', kind: 'tool.completed', payload: { tool: 'search', success: true, result: 'Inventory reference found' } });
			await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', kind: 'agent.message', payload: { role: 'assistant', text: 'Reviewed the files.' } });
			await sink.complete('completed');
			onFinished(options.sessionId);
		},
		async cancel() {}, async shutdown() {},
	}) });
	testContext.after(async () => dashboard.close());
	const { runId } = await fetch(new URL('/api/chat', dashboard.url), {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Review the sample.' }),
	}).then((response) => response.json());
	const run = await waitForRun(dashboard.url, runId);
	assert.equal(run.status, 'completed');
	const reads = run.activity.entries.filter((entry) => entry.category === 'files');
	assert.equal(JSON.stringify(run.trace).includes('gpt-4.1-mini'), false);
	assert.equal(reads.length, 1);
	assert.equal(reads[0].title, 'Read 100 files');
	assert.equal(reads[0].resources.length, 100);
	assert.equal(reads[0].sources.length, 300);
	assert.ok(reads[0].sources.every((source) => source.evidenceGrade === 'observed-native'));
	const mcp = run.activity.entries.find((entry) => entry.tools.some((tool) => tool.server === 'docs'));
	assert.equal(mcp.title, 'MCP tool: docs / search');
	assert.ok(mcp.details.some((detail) => detail.value === 'Inventory reference found'));
	const exported = await fetch(new URL(`/api/runs/${runId}/download`, dashboard.url)).then((response) => response.json());
	assert.ok(reads[0].sources.every((source) => exported.sourceEvents.some((event) => event.eventId === source.id)));
});

test('dashboard presentation and JSON export redact prompt secrets without changing model input', async (testContext) => {
	const dashboard = await startWebDashboard({ provider: 'offline-demo' });
	testContext.after(async () => dashboard.close());
	const { runId } = await fetch(new URL('/api/chat', dashboard.url), {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Check password=sample-private-value in this request.' }),
	}).then((response) => response.json());
	const run = await waitForRun(dashboard.url, runId);
	assert.equal(run.status, 'completed');
	assert.equal(JSON.stringify(run).includes('sample-private-value'), false);
	const exported = await fetch(new URL(`/api/runs/${runId}/download`, dashboard.url)).then((response) => response.text());
	assert.equal(exported.includes('sample-private-value'), false);
	assert.ok(exported.includes('[REDACTED]'));
});

test('dashboard defaults to Copilot CLI and reports its actual model rather than OpenAI configuration', async (testContext) => {
	const previousProvider = process.env.MODEL_WORKLOG_DEMO_PROVIDER;
	const previousModel = process.env.MODEL_WORKLOG_DEMO_OPENAI_MODEL;
	let dashboard;
	try {
		delete process.env.MODEL_WORKLOG_DEMO_PROVIDER;
		process.env.MODEL_WORKLOG_DEMO_OPENAI_MODEL = 'unrelated-openai-model';
		dashboard = await startWebDashboard({ copilotRelayFactory: (sink, options, onFinished) => ({
			async start() {
				assert.equal(options.model, undefined);
				await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', kind: 'agent.message', payload: { role: 'assistant', text: 'Copilot reviewed the workspace.' } });
				await sink.recordUsage({ source: 'provider-reported', provider: 'github-copilot', model: 'copilot-reported-model', inputTokens: 9, outputTokens: 4, totalTokens: 13 }, 'observed-native');
				await sink.complete('completed');
				onFinished(options.sessionId);
			},
			async cancel() {}, async shutdown() {},
		}) });
	} finally {
		if (previousProvider === undefined) { delete process.env.MODEL_WORKLOG_DEMO_PROVIDER; } else { process.env.MODEL_WORKLOG_DEMO_PROVIDER = previousProvider; }
		if (previousModel === undefined) { delete process.env.MODEL_WORKLOG_DEMO_OPENAI_MODEL; } else { process.env.MODEL_WORKLOG_DEMO_OPENAI_MODEL = previousModel; }
	}
	testContext.after(async () => dashboard.close());
	const config = await fetch(new URL('/api/config', dashboard.url)).then((response) => response.json());
	assert.equal(config.mode, 'copilot');
	const { runId } = await fetch(new URL('/api/chat', dashboard.url), {
		method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'List the sample files.' }),
	}).then((response) => response.json());
	const run = await waitForRun(dashboard.url, runId);
	assert.equal(run.status, 'completed');
	assert.equal(run.response, 'Copilot reviewed the workspace.');
	assert.ok(run.trace.activity.some((entry) => entry.category === 'model' && entry.title.includes('copilot-reported-model')));
	assert.equal(JSON.stringify(run).includes('unrelated-openai-model'), false);
	assert.equal(JSON.stringify(run).includes('built-in demo response'), false);
});

test('dashboard consumes semantic backend logs without lifecycle spam, duplicate usage or merged progress replies', async (testContext) => {
	const dashboard = await startWebDashboard({ provider: 'copilot', copilotRelayFactory: (sink, options, onFinished) => ({
		async start() {
			assert.equal(options.captureReasoning, true);
			await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', kind: 'adapter.lifecycle', payload: { adapter: 'copilot-cli', phase: 'model-call-start' } });
			await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', kind: 'agent.message', payload: { role: 'assistant', text: 'Reading the source first.' } });
			await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', kind: 'file.read', payload: { path: 'src/inventory.ts', pathType: 'file' } });
			await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', kind: 'agent.summary', payload: { source: 'reasoning-summary', summary: 'Availability is clamped, so inspect price validation next.' } });
			await sink.recordUsage({ source: 'provider-reported', provider: 'github-copilot', model: 'reported-model', inputTokens: 8, outputTokens: 3, totalTokens: 11 }, 'observed-native');
			await sink.recordUsage({ source: 'provider-reported', provider: 'github-copilot', model: 'reported-model', inputTokens: 10, outputTokens: 4, totalTokens: 14 }, 'observed-native');
			await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', kind: 'agent.message', payload: { role: 'assistant', text: 'Final concise review.' } });
			await sink.complete('completed'); onFinished(options.sessionId);
		}, async cancel() {}, async shutdown() {},
	}) });
	testContext.after(async () => dashboard.close());
	const { runId } = await fetch(new URL('/api/chat', dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Review inventory.' }) }).then((response) => response.json());
	const run = await waitForRun(dashboard.url, runId);
	assert.equal(run.response, 'Final concise review.');
	assert.equal(run.log.usage.counts.totalTokens, 25);
	assert.equal(run.log.summary.filesRead, 1);
	assert.equal(run.log.capture.reasoning, 'provided');
	assert.equal(run.activity.entries.filter((entry) => entry.category === 'usage').length, 1);
	assert.equal(run.activity.entries.some((entry) => entry.category === 'lifecycle'), false);
	assert.deepEqual(run.activity.entries.slice(0, 3).map((entry) => entry.category), ['response', 'files', 'reasoning-summary']);
});