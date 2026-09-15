import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SessionEvent } from 'model-worklog-schema';

import { PRICE_TABLE_VERSION, calculateCostReport } from './pricing';

function usage(sequence: number, payload: SessionEvent['payload']): SessionEvent {
	return {
		schemaVersion: 1, eventId: `evt_${sequence}`, sessionId: 'ses_cost', sequence, occurredAt: '2026-09-15T12:00:00.000Z',
		kind: 'usage.reported', actor: 'integration', evidenceGrade: 'model-declared', payload,
		redaction: { policyVersion: '1', replacements: 0, truncated: false },
	};
}

test('calculates standard OpenAI costs with cache reads excluded from base input pricing', () => {
	const report = calculateCostReport([
		usage(1, { provider: 'openai', model: 'gpt-5.6-terra', inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 0, totalTokens: 1_500 }),
	]);
	assert.deepEqual(report, {
		schemaVersion: 1, tableVersion: PRICE_TABLE_VERSION, currency: 'USD', status: 'reported', totalNanoUsd: '7820000', totalUsd: '0.00782',
		lineItems: [{ sequence: 1, provider: 'openai', model: 'gpt-5.6-terra', status: 'priced', totalNanoUsd: '7820000', totalUsd: '0.00782' }],
	});
});

test('uses cache pricing only where provider usage semantics and a table rate are known', () => {
	const report = calculateCostReport([
		usage(1, { provider: 'anthropic', model: 'claude-sonnet-5', inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, totalTokens: 180 }),
		usage(2, { provider: 'gemini', model: 'gemini-2.5-flash', inputTokens: 100, outputTokens: 50, cacheReadTokens: 40, cacheWriteTokens: 0, totalTokens: 150 }),
	]);
	assert.equal(report.status, 'reported');
	assert.deepEqual(report.lineItems.map((line) => line.totalNanoUsd), ['729000', '144200']);
	assert.equal(report.totalNanoUsd, '873200');
	assert.equal(report.totalUsd, '0.0008732');
});

test('does not estimate costs for missing or unmapped provider/model metadata', () => {
	const report = calculateCostReport([
		usage(1, { inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
		usage(2, { provider: 'openai', model: 'future-model', inputTokens: 1, outputTokens: 1, totalTokens: 2 }),
	]);
	assert.equal(report.status, 'unknown');
	assert.equal(report.totalUsd, '0');
	assert.equal(report.lineItems[0]?.reason, 'Provider and model are required for cost calculation.');
	assert.match(report.lineItems[1]?.reason ?? '', /No builtin-2026-09-15 rate/);
});