import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeCodexUsage } from './codexUsage';

test('normalizes current Codex cumulative totals, including cached and reasoning tokens', () => {
	const result = normalizeCodexUsage({ model: 'gpt-5.6-terra', tokenUsage: { total: { inputTokens: 100, outputTokens: 30, totalTokens: 130, cachedInputTokens: 60, cacheWriteInputTokens: 0, reasoningOutputTokens: 10 }, last: { totalTokens: 7 }, modelContextWindow: 200000 } });
	assert.equal(result.ok, true);
	if (result.ok) { assert.equal(result.usage.totalTokens, 130); assert.equal(result.usage.inputTokens, 100); assert.equal(result.usage.cacheReadTokens, 60); assert.equal(result.usage.reasoningTokens, 10); }
});
test('legacy usage still works; missing, invalid or decreasing counters are never invented', () => {
	assert.equal(normalizeCodexUsage({ usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } }).ok, true);
	assert.equal(normalizeCodexUsage({ tokenUsage: { last: { totalTokens: 7 } } }).ok, false);
	assert.equal(normalizeCodexUsage({ tokenUsage: { total: { inputTokens: -1, outputTokens: 3, totalTokens: 2 } } }).ok, false);
	assert.equal(normalizeCodexUsage({ tokenUsage: { total: { inputTokens: 10, outputTokens: 3, totalTokens: 1 } } }).ok, false);
});
