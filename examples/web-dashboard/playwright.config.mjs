import { defineConfig } from '@playwright/test';

export default defineConfig({
	testDir: '.', testMatch: 'browser.spec.mjs', fullyParallel: false, workers: 1,
	timeout: 30_000, expect: { timeout: 10_000 },
	outputDir: '../../output/playwright/results',
	reporter: [['list']],
	use: { browserName: 'chromium', headless: true, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
});
