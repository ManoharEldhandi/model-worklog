import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOKEN_USAGE_SOURCES, isEventKind, isJsonValue, isTokenUsageSource, parseSessionEvent } from './events';

function validEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		eventId: 'evt_01',
		sessionId: 'ses_01',
		sequence: 1,
		occurredAt: '2026-09-15T10:00:00.000Z',
		kind: 'tool.called',
		actor: 'example-agent',
		evidenceGrade: 'model-declared',
		payload: { tool: 'read_file', arguments: { path: 'README.md' } },
		redaction: { policyVersion: '1', replacements: 0, truncated: false },
		...overrides,
	};
}

test('parses a canonical event with nested JSON payload', () => {
	const parsed = parseSessionEvent(validEvent());
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.value.sequence, 1);
		assert.equal(parsed.value.evidenceGrade, 'model-declared');
	}
});

test('unknown evidence requires a stable reason code', () => {
	const missingReason = parseSessionEvent(validEvent({ evidenceGrade: 'unknown' }));
	assert.equal(missingReason.ok, false);

	const parsed = parseSessionEvent(validEvent({ evidenceGrade: 'unknown', unknownReason: 'not-observed' }));
	assert.equal(parsed.ok, true);
});

test('unknown reason cannot be attached to observed evidence', () => {
	const parsed = parseSessionEvent(validEvent({ unknownReason: 'timeout' }));
	assert.equal(parsed.ok, false);
});

test('rejects non-JSON payload values', () => {
	assert.equal(isJsonValue({ nested: ['ok', 2, false] }), true);
	assert.equal(isJsonValue({ invalid: Number.POSITIVE_INFINITY }), false);
	assert.equal(parseSessionEvent(validEvent({ payload: { invalid: Number.POSITIVE_INFINITY } })).ok, false);
});

test('requires RFC3339 supervisor and source timestamps', () => {
	assert.equal(parseSessionEvent(validEvent({ occurredAt: 'today' })).ok, false);
	assert.equal(parseSessionEvent(validEvent({ sourceTimestamp: 'later' })).ok, false);
	assert.equal(parseSessionEvent(validEvent({ sourceTimestamp: '2026-09-15T10:00:00.000Z' })).ok, true);
});

test('token usage sources distinguish provider totals from adapter declarations', () => {
	assert.deepEqual(TOKEN_USAGE_SOURCES, ['provider-reported', 'computed-from-provider-fields', 'adapter-reported']);
	assert.equal(isTokenUsageSource('provider-reported'), true);
	assert.equal(isTokenUsageSource('estimated'), false);
});

test('includes canonical event kinds for adapter lifecycle and instruction loading', () => {
	assert.equal(isEventKind('adapter.lifecycle'), true);
	assert.equal(isEventKind('instruction.loaded'), true);
	assert.equal(isEventKind('workspace.diff'), true);
	assert.equal(isEventKind('file.read'), true);
	assert.equal(isEventKind('session.interrupted'), true);
});