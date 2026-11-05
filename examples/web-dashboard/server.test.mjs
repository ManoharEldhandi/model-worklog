import assert from 'node:assert/strict';
import test from 'node:test';

import { startWebDashboard } from './server.mjs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('folder selection hides default paths, resets old logs, and never deletes the selected project', async () => {
	const folder = await mkdtemp(join(tmpdir(), 'logger-workspace-selection-'));
	const sentinel = join(folder, 'keep.txt'); await writeFile(sentinel, 'keep this project');
	const dashboard = await startWebDashboard({ provider: 'offline-demo' });
	try {
		const post = (path, body) => fetch(new URL(path, dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const { runId } = await (await post('/api/chat', { message: 'old workspace task' })).json();
		await waitForRun(dashboard.url, runId);
		const invalid = await post('/api/workspace', { path: join(folder, 'missing-private-folder') });
		assert.equal(invalid.status, 400); assert.doesNotMatch(await invalid.text(), /missing-private-folder/);
		const selected = await post('/api/workspace', { path: folder }); assert.equal(selected.status, 200);
		const config = await selected.json();
		assert.equal(config.workspace.isolatedCopy, false); assert.equal(JSON.stringify(config).includes(folder), false);
		assert.equal((await fetch(new URL(`/api/runs/${runId}`, dashboard.url))).status, 404);
		const logs = await (await post('/api/logs/query', { question: 'What happened?' })).json(); assert.equal(logs.totals.spans, 0);
		assert.equal((await post('/api/logs/sample', {})).status, 400);
		const reset = await (await post('/api/workspace', { path: '' })).json(); assert.equal(reset.workspace.isolatedCopy, true);
	} finally { await dashboard.close(); assert.equal(await readFile(sentinel, 'utf8'), 'keep this project'); await rm(folder, { recursive: true, force: true }); }
});

test('the configured default folder stays server-side and is used for workspace tasks', async (context) => {
	const folder = await mkdtemp(join(tmpdir(), 'logger-private-default-'));
	const dashboard = await startWebDashboard({ provider: 'offline-demo', workspacePath: folder });
	context.after(async () => { await dashboard.close(); await rm(folder, { force: true, recursive: true }); });
	const config = await fetch(new URL('/api/config', dashboard.url)).then((r) => r.text());
	assert.equal(config.includes(folder), false);
	const page = await fetch(dashboard.url).then((r) => r.text()); assert.equal(page.includes(folder), false);
});

test('Codex chat works in the sample copy, captures commands, and carries prior workspace conversation', async (context) => {
	const tasks = []; const directories = [];
	const dashboard = await startWebDashboard({ provider: 'codex', codexRelayFactory: (sink, options, onFinished) => ({
		async start() {
			tasks.push(options.task); directories.push(options.workspacePath);
			assert.equal(options.model, 'gpt-5.6-terra'); assert.equal(options.effort, 'low');
			assert.match(await readFile(join(options.workspacePath, 'src/pricing.ts'), 'utf8'), /quotedPrice/);
			const base = { actor: 'codex-app-server', evidenceGrade: 'observed-native', correlationId: 'test-command' };
			await sink.append({ ...base, kind: 'command.started', payload: { executable: 'npm test' } });
			await sink.append({ ...base, kind: 'process.output', payload: { stream: 'stdout', text: 'negative quantities must be rejected: assertion failed' } });
			await sink.append({ ...base, kind: 'command.completed', payload: { executable: 'npm test', exitCode: 1 } });
			await sink.append({ ...base, kind: 'agent.message', payload: { role: 'assistant', text: 'The negative quantity test failed in test/pricing.test.ts.' } });
			await sink.complete('completed'); onFinished(options.sessionId);
		}, async cancel() {}, async shutdown() {},
	}) });
	context.after(() => dashboard.close());
	const config = await fetch(new URL('/api/config', dashboard.url)).then((r) => r.json());
	assert.equal(config.mode, 'codex'); assert.equal(config.model, 'gpt-5.6-terra');
	const post = (message) => fetch(new URL('/api/chat', dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message }) }).then((r) => r.json());
	const first = await waitForRun(dashboard.url, (await post('Run the pricing tests.')).runId);
	assert.equal(first.status, 'completed');
	assert.match(JSON.stringify(first.activity), /negative quantities/);
	assert.ok(first.trace.spanCount > 2);
	const second = await waitForRun(dashboard.url, (await post('Which test failed earlier?')).runId);
	assert.equal(second.status, 'completed');
	assert.equal(directories[0], directories[1]); assert.doesNotMatch(directories[0], /sample-workspace$/);
	assert.match(tasks[1], /Run the pricing tests/); assert.match(tasks[1], /negative quantity test failed/);
});

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

test('unavailable semantic services return an actionable error without exposing upstream content', async (context) => {
	const dashboard = await startWebDashboard({ provider: 'offline-demo', rag: { async sync() { throw new Error('private-upstream-token'); } } });
	context.after(() => dashboard.close());
	const response = await fetch(new URL('/api/logs/query', dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'What happened?' }) });
	assert.equal(response.status, 503);
	const payload = await response.text(); assert.match(payload, /Restart the RAG demo/); assert.doesNotMatch(payload, /private-upstream-token/);
});

test('web dashboard records a browser interaction as nested SDK spans', async (testContext) => {
	const dashboard = await startWebDashboard({ provider: 'offline-demo' });
	testContext.after(async () => dashboard.close());

	const page = await fetch(dashboard.url);
	assert.equal(page.status, 200);
	assert.match(await page.text(), /Workspace chat/);
	const logo = await fetch(new URL('/logo.png', dashboard.url));
	assert.equal(logo.status, 200);
	assert.match(logo.headers.get('content-type'), /image\/png/);
	const config = await fetch(new URL('/api/config', dashboard.url)).then((response) => response.json());
	assert.ok(config.workspace.files.includes('test/pricing.test.ts'));

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

test('dashboard shutdown cancels outstanding log answers without waiting for the model deadline', async () => {
	let started;
	const ready = new Promise((resolve) => { started = resolve; });
	let cancelled = false;
	const dashboard = await startWebDashboard({ provider: 'offline-demo', logAnswerGenerator: {
		async generate(_question, _evidence, signal) {
			started();
			return new Promise((_resolve, reject) => signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason); }, { once: true }));
		},
	} });
	const controller = new AbortController();
	const pending = fetch(new URL('/api/logs/query', dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Summarize', synthesis: 'model' }), signal: controller.signal }).catch(() => undefined);
	await ready;
	const change = await fetch(new URL('/api/workspace', dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '' }) });
	assert.equal(change.status, 409, 'Changing folders must not mix an active answer with another workspace.');
	let closed = false;
	const closing = dashboard.close().then(() => { closed = true; });
	const deadline = setTimeout(() => controller.abort(), 1_000);
	try { await closing; assert.equal(cancelled, true); assert.equal(controller.signal.aborted, false, 'Shutdown must finish before the cleanup deadline.'); }
	finally { clearTimeout(deadline); controller.abort(); await pending; if (!closed) { await closing; } }
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
	const answer = await fetch(new URL('/api/logs/query', dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'How many times was read_file used?', traceId: run.traceId }) }).then((response) => response.json());
	assert.equal(answer.totals.toolCalls, 100);
	assert.equal(answer.tools[0].name, 'read_file');
	assert.equal(answer.evidence.length, 8);
	assert.equal(answer.retrieval.truncated, true);
	assert.ok(answer.evidence.every((source) => source.serviceName === 'copilot-tool-projection'));
});

test('sample capture supports exact tool answers, failure retrieval, and retained evidence without model credentials', async (testContext) => {
	const dashboard = await startWebDashboard({ provider: 'offline-demo' });
	testContext.after(async () => dashboard.close());
	const started = await fetch(new URL('/api/logs/sample', dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
	assert.equal(started.status, 202);
	const run = await waitForRun(dashboard.url, (await started.json()).runId);
	assert.equal(run.status, 'completed');
	assert.equal(run.trace.spanCount, 123);
	const query = async (question) => {
		const response = await fetch(new URL('/api/logs/query', dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question, traceId: run.traceId }) });
		assert.equal(response.status, 200);
		return response.json();
	};
	const tools = await query('What tools were used?');
	assert.equal(tools.totals.toolCalls, 122);
	assert.equal(tools.tools.find((tool) => tool.name === 'read_file').calls, 120);
	const specific = await query('How many times was read_file used?');
	assert.equal(specific.totals.toolCalls, 120);
	const failures = await query('What failed?');
	assert.equal(failures.retrieval.matchedSpans, 1);
	assert.match(failures.answer, /Stock quantity must not be negative/);
	const source = failures.evidence[0];
	const evidence = await fetch(new URL(`/api/logs/evidence?traceId=${source.traceId}&spanId=${source.spanId}`, dashboard.url)).then((response) => response.json());
	assert.equal(evidence.span.spanId, source.spanId);
	assert.equal(evidence.span.revision, source.revision);
	assert.equal(JSON.stringify(tools).includes('token'), false);
});

test('dashboard query proxy rejects foreign origins, malformed requests, and project override attempts', async (testContext) => {
	const dashboard = await startWebDashboard({ provider: 'offline-demo' });
	testContext.after(async () => dashboard.close());
	const path = new URL('/api/logs/query', dashboard.url);
	const post = (body, headers = {}) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
	assert.equal((await post('{"question":"tools"}', { origin: 'https://untrusted.example' })).status, 403);
	assert.equal((await post('{"question":"tools"}', { 'sec-fetch-site': 'cross-site' })).status, 403);
	assert.equal((await post('{"question":"tools","projectId":"other"}')).status, 400);
	assert.equal((await post('{"question":"tools","limit":1000}')).status, 400);
	assert.equal((await post('{"question":"tools","__proto__":{}}')).status, 400);
	assert.equal((await post('{malformed')).status, 400);
	assert.equal((await post('{}', { 'content-type': 'text/plain' })).status, 400);
	assert.equal((await post('x'.repeat(131073))).status, 413);
	assert.equal((await fetch(new URL('/api/logs/evidence?traceId=bad&spanId=bad', dashboard.url))).status, 400);
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

test('explicit Copilot mode reports its actual model rather than OpenAI configuration', async (testContext) => {
	const previousProvider = process.env.MODEL_WORKLOG_DEMO_PROVIDER;
	const previousModel = process.env.MODEL_WORKLOG_DEMO_OPENAI_MODEL;
	let dashboard;
	try {
		delete process.env.MODEL_WORKLOG_DEMO_PROVIDER;
		process.env.MODEL_WORKLOG_DEMO_OPENAI_MODEL = 'unrelated-openai-model';
		dashboard = await startWebDashboard({ provider: 'copilot', copilotRelayFactory: (sink, options, onFinished) => ({
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

test('log conversations retrieve actual replies, preserve follow-ups, and generate tool answers without re-running the workspace agent', async (testContext) => {
	let reviews = 0;
	let answers = 0;
	const dashboard = await startWebDashboard({ provider: 'copilot', logAnswerGenerator: {
		provider: 'test-conversation',
		async generate(question, evidence, _signal, history) {
			answers += 1;
			assert.equal(evidence.scope.projectId, 'web-demo');
			if (question.includes('answer')) {
				assert.ok(evidence.evidence.some((source) => source.excerpt.includes('spring discount is 15 percent')));
				const source = evidence.evidence.find((source) => source.excerpt.includes('spring discount is 15 percent'));
				return { answer: `It said the spring discount is 15 percent. [${source.id}]`, sourceIds: [source.id] };
			}
			assert.equal(history[0].content, 'What did it answer?');
			return { answer: `It made ${evidence.totals.toolCalls} recorded tool calls. [A1]`, sourceIds: ['A1'] };
		},
	}, copilotRelayFactory: (sink, options, onFinished) => ({
		async start() {
			reviews += 1;
			await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', correlationId: 'read', kind: 'tool.called', payload: { tool: 'view', arguments: { path: 'src/pricing.ts' } } });
			await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', correlationId: 'read', kind: 'tool.completed', payload: { tool: 'view', success: true, result: 'Pricing source' } });
			await sink.append({ actor: 'copilot-cli', evidenceGrade: 'observed-native', kind: 'agent.message', payload: { role: 'assistant', text: 'The spring discount is 15 percent.' } });
			await sink.complete('completed'); onFinished(options.sessionId);
		}, async cancel() {}, async shutdown() {},
	}) });
	testContext.after(async () => dashboard.close());
	const { runId } = await fetch(new URL('/api/chat', dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'Review pricing.' }) }).then((response) => response.json());
	const run = await waitForRun(dashboard.url, runId);
	const ask = (body) => fetch(new URL('/api/logs/query', dashboard.url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ traceId: run.traceId, synthesis: 'model', ...body }) }).then((response) => response.json());
	const first = await ask({ question: 'What did it answer?' });
	assert.equal(first.generation.status, 'generated');
	assert.match(first.answer, /spring discount/);
	const followup = await ask({ question: 'And how many tools did it use?', history: [{ role: 'user', content: 'What did it answer?' }, { role: 'assistant', content: first.answer }] });
	assert.equal(followup.generation.status, 'generated');
	assert.match(followup.answer, /1 recorded tool calls/);
	assert.equal(reviews, 1);
	assert.equal(answers, 2);
});
