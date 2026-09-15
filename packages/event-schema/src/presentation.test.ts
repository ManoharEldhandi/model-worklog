import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatSessionEventText, presentSessionEvent } from './presentation';
import type { SessionEvent } from './events';

function event(kind: SessionEvent['kind'], payload: SessionEvent['payload']): SessionEvent {
	return {
		schemaVersion: 1,
		eventId: 'evt_demo',
		sessionId: 'ses_demo',
		sequence: 4,
		occurredAt: '2026-09-15T12:00:00.000Z',
		kind,
		actor: 'demo-agent',
		evidenceGrade: 'model-declared',
		correlationId: 'tool_42',
		payload,
		redaction: { policyVersion: '1', replacements: 0, truncated: false },
	};
}

test('presents readable reasoning summaries, tools, files, and tool results', () => {
	const reasoning = presentSessionEvent(event('agent.summary', { source: 'reasoning-summary', summary: 'I will inspect the parser before changing it.' }));
	assert.equal(reasoning.title, 'Agent reasoning summary');
	assert.deepEqual(reasoning.details, [{ label: 'Summary', value: 'I will inspect the parser before changing it.' }]);
	assert.equal(presentSessionEvent(event('agent.message', { role: 'user', text: 'Inspect the parser.' })).title, 'User request');

	const lines = formatSessionEventText(event('tool.completed', {
		tool: 'read_file',
		success: true,
		result: { path: 'src/parser.ts', linesRead: 84 },
	}));
	assert.ok(lines.includes('  Tool completed: read_file'));
	assert.ok(lines.includes('  Result: {'));
	assert.ok(lines.includes('      "path": "src/parser.ts",'));
	assert.ok(lines.includes('  Correlation: tool_42'));
});

test('presents file and workspace activity without rendering a raw diff into text', () => {
	const read = presentSessionEvent(event('file.read', { path: 'src/parser.ts', tool: 'read_file' }));
	assert.equal(read.title, 'Read file: src/parser.ts');

	const change = presentSessionEvent(event('workspace.diff', {
		changedSinceStart: true,
		current: { paths: ['src/parser.ts', 'src/parser.test.ts'], diffSha256: 'abc123', truncated: false },
		diff: 'private diff content is retained in JSON only',
	}));
	assert.equal(change.title, 'Workspace changes detected');
	assert.deepEqual(change.details[0], { label: 'Changed files', value: '[\n  "src/parser.ts",\n  "src/parser.test.ts"\n]' });
	assert.equal(JSON.stringify(change).includes('private diff content'), false);
});

test('uses plain language when a provider did not report token counts', () => {
	const usage = presentSessionEvent({
		...event('usage.unavailable', { message: 'The provider did not send token counters.' }),
		evidenceGrade: 'unknown',
		unknownReason: 'not-observed',
	});
	assert.equal(usage.title, 'Token count not reported');
	assert.deepEqual(usage.details, [{ label: 'Details', value: 'The provider did not send token counters.' }]);
});