import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { startWebDashboard } from './server.mjs';

const test = base.extend({
	dashboard: async ({}, use) => {
		const requests = [];
		const instance = await startWebDashboard({ provider: 'offline-demo', logAnswerGenerator: {
			provider: 'test-evidence',
			async generate(question, evidence, signal, history) {
				requests.push({ question, evidence, history });
				if (question.includes('Wait')) { await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); }
				if (question.includes('invalid citation')) { return { answer: 'Invented claim [S999].', sourceIds: ['S999'] }; }
				if (question.includes('unsafe')) { return { answer: '<img src=x onerror="window.attack=true"><script>window.attack=true</script>Captured evidence [A1]. [unsafe](javascript:alert(1))', sourceIds: ['A1'] }; }
				if (evidence.totals.spans === 0) { return { answer: 'No retained evidence is available in this scope.', sourceIds: [] }; }
				if (/how many|tools/i.test(question)) { return { answer: `There were ${evidence.totals.toolCalls} recorded tool calls in this scope. [A1]`, sourceIds: ['A1'] }; }
				const source = evidence.evidence[0];
				return { answer: `Captured record: ${source.name}. [${source.id}]`, sourceIds: [source.id] };
			},
		} });
		try { await use({ ...instance, requests }); } finally { await instance.close(); }
	},
});

async function openLogs(page, dashboard) {
	await page.goto(dashboard.url);
	await expect(page.locator('#connection-status')).toContainText('Local collector');
	await page.getByRole('radio', { name: 'Ask logs', exact: true }).check();
}
async function record(page) {
	await page.getByRole('button', { name: 'Load offline example' }).click();
	await expect(page.locator('#query-status')).toHaveText('Evidence-only answer');
	await expect(page.locator('#run-state')).toHaveText('completed');
}
async function ask(page, question) {
	await page.getByRole('textbox', { name: 'Question about the logs' }).fill(question);
	await page.getByRole('button', { name: 'Send log question' }).click();
	await expect(page.locator('#query-stop')).toBeHidden();
	return page.locator('.log-turn').last();
}

test('selecting a project folder clears the previous log conversation and keeps the entered path off the page', async ({ page, dashboard }) => {
	const folder = await mkdtemp(join(tmpdir(), 'logger-browser-project-'));
	await writeFile(join(folder, 'README.md'), 'A separate example project.');
	try {
		await openLogs(page, dashboard); await record(page);
		await page.getByLabel('Project folder').fill(folder);
		await page.getByRole('button', { name: 'Use folder', exact: true }).click();
		await expect(page.locator('#workspace-status')).toContainText('fresh log session');
		await expect(page.getByLabel('Project folder')).toHaveValue('');
		await expect(page.locator('#run-state')).toHaveText('Idle');
		await expect(page.locator('.log-turn')).toHaveCount(0);
		await expect(page.locator('#sample-button')).toBeHidden();
		await expect(page.locator('#workspace-context')).not.toContainText(folder);
		const turn = await ask(page, 'What happened?');
		await expect(turn.locator('.query-answer')).toContainText('No retained spans');
		await expect(page.locator('#messages')).not.toContainText('negative stock');
	} finally { await rm(folder, { recursive: true, force: true }); }
});

test('capture → SQL counts → cited model reply → source snapshot → redacted export', async ({ page, dashboard }) => {
	const errors = []; page.on('pageerror', (error) => errors.push(error.message));
	await openLogs(page, dashboard); await record(page);
	await page.locator('#query-model').check();
	let turn = await ask(page, 'How many times was read_file used? token=private-question');
	await expect(turn.locator('.query-answer')).toContainText('120 recorded tool calls');
	await expect(turn.locator('.log-question')).not.toContainText('private-question');
	await turn.locator('.citation-link').click();
	await expect(turn.locator('[id$="-A1"]')).toHaveAttribute('open', '');
	turn = await ask(page, 'What did it answer?');
	await expect(turn.locator('.query-answer .citation-link')).toBeVisible();
	await turn.locator('.query-answer .citation-link').click();
	await turn.getByRole('button', { name: 'Open retained source' }).first().click();
	await expect(turn.locator('.query-source-record')).toContainText('spanId');
	expect(dashboard.requests.at(-1).history.some((message) => message.content.includes('read_file'))).toBe(true);
	const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export chat' }).click();
	const file = await (await download).path(); const exported = await readFile(file, 'utf8');
	expect(exported).not.toContain('private-question');
	expect(JSON.parse(exported).turns.length).toBe(3);
	expect(errors).toEqual([]);
	await page.screenshot({ path: 'output/playwright/log-rag-conversation.png', fullPage: true });
});

test('model failures are labelled fallbacks and unsafe Markdown cannot execute', async ({ page, dashboard }) => {
	await openLogs(page, dashboard); await record(page); await page.locator('#query-model').check();
	let turn = await ask(page, 'Return an invalid citation');
	await expect(turn.locator('.message-label').last()).toHaveText('Evidence fallback');
	await expect(turn.locator('.query-answer')).not.toContainText('Invented claim');
	turn = await ask(page, 'Show unsafe content');
	await expect(turn.locator('.query-answer')).toContainText('Captured evidence');
	await expect(turn.locator('.query-answer img, .query-answer script, .query-answer a[href^="javascript:"]')).toHaveCount(0);
	expect(await page.evaluate(() => window.attack)).toBeUndefined();
});

test('stopping and changing scope discard pending replies and old history', async ({ page, dashboard }) => {
	await openLogs(page, dashboard); await record(page); await page.locator('#query-model').check();
	await page.locator('#question').fill('Wait for cancellation'); await page.locator('#ask-button').click();
	await expect.poll(() => dashboard.requests.length).toBe(1);
	await expect(page.locator('.log-turn').last().locator('.message-label').last()).toHaveText('Assistant');
	await page.getByRole('button', { name: 'Stop', exact: true }).click();
	await expect(page.locator('#query-status')).toHaveText('Stopped');
	await expect(page.locator('.log-turn').last()).toContainText('Answer stopped.');
	await page.locator('#question').fill('Wait again'); await page.locator('#ask-button').click();
	await expect.poll(() => dashboard.requests.length).toBe(2);
	await page.locator('#query-scope').selectOption('all');
	await expect(page.locator('.log-turn')).toHaveCount(0);
	await ask(page, 'How many tools?');
	expect(dashboard.requests.at(-1).history).toEqual([]);
	await page.getByRole('button', { name: 'New chat', exact: true }).click();
	await expect(page.locator('.log-turn')).toHaveCount(0);
});

test('local contextual answers work without model access and empty scope is honest', async ({ page, dashboard }) => {
	await openLogs(page, dashboard);
	let turn = await ask(page, 'What happened?');
	await expect(turn.locator('.query-answer')).toContainText('No retained spans');
	await record(page);
	turn = await ask(page, 'What did it answer?');
	await expect(turn.locator('.query-answer')).toContainText('contextual records');
	await expect(turn.locator('.query-answer')).toContainText('Read the inventory files');
	expect(dashboard.requests).toEqual([]);
});
