import { test, expect } from '@playwright/test';
import { startWebDashboard } from './server.mjs';

test('SDK RAG browser: natural answers, missing amount, citations and source inspection', async ({ page }) => {
	test.skip(!process.env.MODEL_WORKLOG_TEST_CHROMA_URL, 'Run with the live RAG service harness.');
	const errors = []; page.on('pageerror', (error) => errors.push(error.message));
	const dashboard = await startWebDashboard({ provider: 'offline-demo', logAnswerGenerator: {
		provider: 'test-model', async generate(question, evidence) {
			expect(evidence.retrieval.strategy).toBe('chroma-hybrid');
			const source = evidence.evidence.find((source) => source.excerpt.includes('180')) ?? evidence.evidence[0];
			return { answer: /amount/i.test(question) ? `The refund amount wasn't captured in these logs. [${source.id}]` : `The refund was rejected because the payment was 190 days old, beyond the 180-day window. [${source.id}]`, sourceIds: [source.id] };
		},
	} });
	try {
		await page.goto(dashboard.url);
		await expect(page.getByRole('radio', { name: 'Ask logs', exact: true })).toBeChecked();
		await page.getByLabel('Sample scenario').selectOption('refund');
		await page.getByRole('button', { name: 'Record sample', exact: true }).click();
		await expect(page.locator('#run-state')).toHaveText('completed');
		await expect(page.locator('#query-stop')).toBeHidden();
		await page.locator('#query-model').check();
		await page.getByRole('textbox', { name: 'Question about the logs' }).fill('Why did the refund fail?');
		await page.getByRole('button', { name: 'Send log question' }).click();
		let turn = page.locator('.log-turn').last();
		await expect(turn.locator('.query-answer')).toContainText('beyond the 180-day window');
		await expect(turn.locator('.answer-provenance')).toContainText('Semantic log search');
		await turn.locator('.citation-link').click();
		await turn.getByRole('button', { name: 'Open retained source' }).first().click();
		await expect(turn.locator('.query-source-record')).toContainText('spanId');
		await page.getByRole('textbox', { name: 'Question about the logs' }).fill('What is the amount?');
		await page.getByRole('button', { name: 'Send log question' }).click();
		turn = page.locator('.log-turn').last();
		await expect(turn.locator('.query-answer')).toContainText("wasn't captured");
		await expect(turn.locator('.query-answer')).not.toContainText('190');
		await expect(turn.locator('.query-answer')).not.toContainText('attributes:');
		expect(errors).toEqual([]);
		await page.screenshot({ path: 'output/playwright/sdk-rag-browser.png', fullPage: true });
	} finally { await dashboard.close(); }
});
