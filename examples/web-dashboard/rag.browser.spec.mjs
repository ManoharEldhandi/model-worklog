import { test, expect } from '@playwright/test';
import { startWebDashboard } from './server.mjs';
import { workspaceRelay } from './fixtures/workspaceRelay.mjs';

test('workspace agent chat → captured activity → SDK RAG answer and original source', async ({ page }) => {
	test.setTimeout(90_000);
	test.skip(!process.env.MODEL_WORKLOG_TEST_CHROMA_URL, 'Run with the live RAG service harness.');
	const errors = []; page.on('pageerror', (error) => errors.push(error.message));
	const dashboard = await startWebDashboard({ provider: 'codex', codexRelayFactory: workspaceRelay, logAnswerGenerator: {
		provider: 'test-model', async generate(_question, evidence) {
			expect(evidence.retrieval.strategy).toBe('chroma-hybrid');
			const source = evidence.evidence.find((source) => /negative quantit/i.test(source.excerpt));
			return { answer: `The negative quantity test failed because quotedPrice accepted a negative order quantity. [${source.id}]`, sourceIds: [source.id] };
		},
	} });
	try {
		await page.goto(dashboard.url);
		await expect(page.getByRole('radio', { name: 'Activity', exact: true })).toBeChecked();
		await expect(page.locator('#provider-mode')).toContainText('gpt-5.6-terra');
		await expect(page.locator('#sample-button')).toBeHidden();
		await page.getByRole('button', { name: 'Inspect code and run tests' }).click();
		await page.getByRole('button', { name: 'Send request', exact: true }).click();
		await expect(page.locator('#run-state')).toHaveText('completed');
		await expect(page.locator('#messages')).toContainText('negative quantities');
		await page.getByRole('button', { name: 'Ask about this run’s logs' }).click();
		await page.locator('#query-model').check();
		await page.getByRole('textbox', { name: 'Question about the logs' }).fill('Which test failed and why?');
		await page.getByRole('button', { name: 'Send log question' }).click();
		const turn = page.locator('.log-turn').last();
		await expect(turn.locator('.query-answer')).toContainText('negative quantity', { timeout: 45_000 });
		await expect(turn.locator('.answer-provenance')).toContainText('Semantic log search');
		await turn.locator('.citation-link').click();
		await turn.getByRole('button', { name: 'Open retained source' }).first().click();
		await expect(turn.locator('.query-source-record')).toContainText('spanId');
		expect(errors).toEqual([]);
		await page.screenshot({ path: 'output/playwright/sdk-rag-browser.png', fullPage: true });
	} finally { await dashboard.close(); }
});
