import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FileEvidenceLedger, workspaceFingerprint } from './ledger';

async function withLedger(run: (ledger: FileEvidenceLedger, root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), 'model-worklog-ledger-'));
	try {
		await run(await FileEvidenceLedger.open(root, () => new Date('2026-09-15T10:00:00.000Z')), root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

test('persists redacted, supervisor-sequenced events without a raw workspace path', async () => {
	await withLedger(async (ledger, root) => {
		const workspacePath = '/private/projects/secret-workspace';
		const session = await ledger.createSession({ runMode: 'managed', actor: 'demo-agent', workspacePath });
		const event = await ledger.append(session.sessionId, {
			kind: 'agent.message',
			actor: 'demo-agent',
			evidenceGrade: 'model-declared',
			payload: { text: 'Calling API with apiKey=not-for-disk' },
		});
		assert.equal(event.sequence, 2);
		assert.equal(JSON.stringify(event.payload).includes('not-for-disk'), false);
		assert.equal(event.redaction.replacements, 1);
		assert.equal(session.workspace.fingerprint, workspaceFingerprint(workspacePath));
		assert.notEqual(session.workspace.label, workspacePath);

		const raw = await readFile(join(root, 'sessions', `${session.sessionId}.jsonl`), 'utf8');
		assert.equal(raw.includes('not-for-disk'), false);
		assert.equal(raw.includes(workspacePath), false);
	});
});

test('stores a redacted supplied task name or derives one from the first user request', async () => {
	await withLedger(async (ledger) => {
		const supplied = await ledger.createSession({ runMode: 'observe', actor: 'demo-agent', workspacePath: '/workspace', title: 'Fix apiKey=top-secret parser test' });
		assert.equal(supplied.title, 'Fix apiKey=[REDACTED] parser test');

		const inferred = await ledger.createSession({ runMode: 'observe', actor: 'demo-agent', workspacePath: '/workspace' });
		await ledger.append(inferred.sessionId, {
			kind: 'agent.message', actor: 'demo-agent', evidenceGrade: 'model-declared',
			payload: { role: 'user', text: 'Review the parser failure and update the test.' },
		});
		assert.equal((await ledger.getSession(inferred.sessionId))?.title, 'Review the parser failure and update the test.');
	});
});

test('aggregates explicitly reported token totals and retains unknown otherwise', async () => {
	await withLedger(async (ledger) => {
		const session = await ledger.createSession({ runMode: 'observe', actor: 'demo-agent', workspacePath: '/workspace' });
		assert.deepEqual(session.tokenUsage, { status: 'unknown', reason: 'not-observed' });
		const afterFirst = await ledger.recordUsage(session.sessionId, { source: 'provider-reported', provider: 'openai', model: 'gpt-example', inputTokens: 10, outputTokens: 5, reasoningTokens: 2, totalTokens: 15 });
		const afterSecond = await ledger.recordUsage(session.sessionId, { source: 'provider-reported', provider: 'openai', model: 'gpt-example', inputTokens: 3, outputTokens: 7, totalTokens: 10 });
		assert.equal(afterFirst.tokenUsage.status, 'reported');
		assert.deepEqual(afterSecond.tokenUsage, {
			status: 'reported', source: 'provider-reported', providers: ['openai'], models: ['gpt-example'], inputTokens: 13, outputTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 2, totalTokens: 25,
		});
	});
});

test('keeps reported usage when a later observation cannot provide token counts', async () => {
	await withLedger(async (ledger) => {
		const session = await ledger.createSession({ runMode: 'observe', actor: 'demo-agent', workspacePath: '/workspace' });
		await ledger.recordUsage(session.sessionId, { source: 'provider-reported', provider: 'openai', totalTokens: 12 });
		const updated = await ledger.recordUsageUnknown(session.sessionId, 'not-observed');

		assert.deepEqual(updated.tokenUsage, {
			status: 'reported', source: 'provider-reported', providers: ['openai'], models: [], inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 12,
		});
	});
});

test('persists a terminal session state after its final canonical event', async () => {
	await withLedger(async (ledger) => {
		const session = await ledger.createSession({ runMode: 'managed', actor: 'boundary', workspacePath: '/workspace' });
		const completed = await ledger.complete(session.sessionId, 'completed');
		assert.equal(completed.state, 'completed');
		assert.equal(completed.eventCount, 2);
		assert.ok(completed.completedAt);
		await assert.rejects(
			() => ledger.append(session.sessionId, {
				kind: 'agent.message', actor: 'boundary', evidenceGrade: 'observed-boundary', payload: { text: 'too late' },
			}),
			/already completed/,
		);
	});
});