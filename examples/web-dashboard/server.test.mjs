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
	assert.match(await page.text(), /Copilot review/);
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
	assert.equal(run.events.length, 6);
	assert.equal(run.events.at(-1).message, 'Token usage');
	assert.equal(run.events.at(-1).detail, 'Not reported by the provider.');
	assert.equal(run.trace.spanCount, 3);
	assert.deepEqual(run.trace.spans.map((span) => span.name), [
		'website.chat',
		'prompt.classify',
		'model.chat.completions',
	]);

	const download = await fetch(new URL(`/api/runs/${runId}/download`, dashboard.url));
	assert.equal(download.status, 200);
	assert.match(download.headers.get('content-disposition') ?? '', /attachment; filename="model-worklog-run-/);
	const exported = await download.json();
	assert.equal(exported.schemaVersion, 1);
	assert.equal(exported.interaction.message, 'Show the browser trace for this request.');
	assert.equal(exported.run.trace.spanCount, 3);
	assert.equal('token' in exported, false);
});