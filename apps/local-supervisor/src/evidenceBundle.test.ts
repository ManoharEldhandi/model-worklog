import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { SessionEvent, SessionRecord } from 'model-worklog-schema';

import { createEvidenceBundle, verifyEvidenceBundle } from './evidenceBundle';

const session: SessionRecord = {
	schemaVersion: 1, sessionId: 'ses_bundle', runMode: 'observe', state: 'completed', actor: 'test-agent',
	workspace: { label: 'workspace', fingerprint: 'workspace-fingerprint' }, createdAt: '2026-09-15T10:00:00.000Z', completedAt: '2026-09-15T10:01:00.000Z', eventCount: 2,
	tokenUsage: { status: 'unknown', reason: 'not-observed' },
};

function event(sequence: number): SessionEvent {
	return {
		schemaVersion: 1, eventId: `evt_${sequence}`, sessionId: session.sessionId, sequence, occurredAt: `2026-09-15T10:00:0${sequence}.000Z`,
		kind: sequence === 1 ? 'agent.summary' : 'workspace.diff', actor: 'test-agent', evidenceGrade: sequence === 1 ? 'model-declared' : 'observed-boundary',
		payload: sequence === 1 ? { summary: 'completed' } : { baseline: { paths: [], diffSha256: 'a', dirty: false }, current: { paths: [], diffSha256: 'a', truncated: false }, changedSinceStart: false, diff: '' },
		redaction: { policyVersion: '1', replacements: 0, truncated: false },
	};
}

test('creates a stable canonical bundle from out-of-order retained events', () => {
	const first = createEvidenceBundle(session, [event(2), event(1)], '2026-09-15T10:02:00.000Z');
	const second = createEvidenceBundle(session, [event(1), event(2)], '2026-09-15T10:02:00.000Z');
	assert.deepEqual(first, second);
	assert.deepEqual(first.events.map((entry) => entry.sequence), [1, 2]);
	assert.deepEqual(first.workspaceDiffs.map((entry) => entry.sequence), [2]);
	assert.deepEqual(verifyEvidenceBundle(first), { schemaVersion: 1, valid: true });
});

test('scrubs POSIX, Windows, and file URL absolute paths before hashing', () => {
	const bundle = createEvidenceBundle(session, [{
		...event(1), payload: { posix: '/Users/example/private.txt', windows: 'C:\\Users\\example\\private.txt', fileUrl: 'file:///Users/example/private.txt' },
	}], '2026-09-15T10:02:00.000Z');
	const serialized = JSON.stringify(bundle);
	assert.equal(serialized.includes('/Users/example/private.txt'), false);
	assert.equal(serialized.includes('C:\\Users\\example\\private.txt'), false);
	assert.equal(serialized.includes('0[PATH REDACTED]'), false);
	assert.equal(bundle.exportRedaction.pathReplacements, 3);
	assert.deepEqual(verifyEvidenceBundle(bundle), { schemaVersion: 1, valid: true });
});