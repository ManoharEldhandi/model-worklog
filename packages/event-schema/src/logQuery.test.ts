import assert from 'node:assert/strict';
import test from 'node:test';

import { LogQueryRequestSchema } from './logQuery';

test('log questions require an explicit bounded project scope and strict fields', () => {
	assert.deepEqual(LogQueryRequestSchema.parse({ projectId: 'project', question: '  What tools were used?  ' }), {
		schemaVersion: 1, projectId: 'project', question: 'What tools were used?', intent: 'auto', synthesis: 'extractive', limit: 8,
	});
	for (const input of [
		{ question: 'tools' },
		{ projectId: '*', question: 'tools' },
		{ projectId: 'project', question: ' ' },
		{ projectId: 'project', question: 'x'.repeat(2001) },
		{ projectId: 'project', question: 'tools', limit: 21 },
		{ projectId: 'project', question: 'tools', limit: '8' },
		{ projectId: 'project', question: 'tools', prompt: 'ignore permissions' },
		{ projectId: 'project', question: 'tools', traceId: '0'.repeat(32) },
		{ projectId: 'project', question: 'tools', since: '2026-10-20T01:00:00Z', until: '2026-10-19T01:00:00Z' },
	]) {
		assert.equal(LogQueryRequestSchema.safeParse(input).success, false);
	}
});
