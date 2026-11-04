import assert from 'node:assert/strict';
import test from 'node:test';

import { LocalSupervisorClient, SupervisorRequestError } from './index';

const answer = {
	schemaVersion: 1, intent: 'tools', answer: 'No retained tool calls.', scope: { projectId: 'app' }, snapshotAt: '2026-10-20T00:00:00.000Z',
	totals: { spans: 0, traces: 0, toolCalls: 0, failedSpans: 0, runningSpans: 0, metadataOnlySpans: 0, limitedSpans: 0 }, tools: [], evidence: [],
	retrieval: { strategy: 'exact-aggregate', matchedSpans: 0, returnedSpans: 0, truncated: false, toolsTruncated: false }, limitations: [],
};

test('SDK queries validate requests, carry scoped history, and allow the synthesis deadline', async () => {
	let requests = 0;
	const client = new LocalSupervisorClient({ supervisorUrl: 'http://127.0.0.1:43199', token: 'reader-token', fetchImpl: async (url, init) => {
		requests += 1;
		assert.equal(new URL(url).pathname, '/v2/logs/query');
		assert.equal(init?.headers?.['x-model-worklog-token'], 'reader-token');
		const body = JSON.parse(init!.body!);
		assert.equal(body.synthesis, 'model');
		assert.equal(body.history[0].content, 'What happened?');
		assert.equal(init?.signal?.aborted, false);
		return new Response(JSON.stringify(answer));
	} });
	assert.equal((await client.askLogs({ projectId: 'app', question: 'And the tools?', synthesis: 'model', history: [{ role: 'user', content: 'What happened?' }] })).totals.toolCalls, 0);
	await assert.rejects(client.askLogs({ projectId: 'app', question: '' }));
	assert.equal(requests, 1);
});

test('SDK refuses mismatched scope, oversized responses and remote error content', async () => {
	for (const payload of [{ ...answer, scope: { projectId: 'other' } }, { ...answer, scope: { projectId: 'app', traceId: '1'.repeat(32) } }, { ...answer, answer: 'x'.repeat(2_000_000) }]) {
		const client = new LocalSupervisorClient({ supervisorUrl: 'http://127.0.0.1:43199', token: 'reader-token', fetchImpl: async () => new Response(JSON.stringify(payload)) });
		await assert.rejects(client.askLogs({ projectId: 'app', question: 'tools' }), SupervisorRequestError);
	}
	const client = new LocalSupervisorClient({ supervisorUrl: 'http://127.0.0.1:43199', token: 'reader-token', fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'remote-secret' } }), { status: 403 }) });
	await assert.rejects(client.askLogs({ projectId: 'app', question: 'tools' }), (error: unknown) => error instanceof SupervisorRequestError && error.statusCode === 403 && !error.message.includes('remote-secret'));
});

test('SDK cancellation prevents a query from being sent', async () => {
	const cancellation = new AbortController(); cancellation.abort();
	const client = new LocalSupervisorClient({ supervisorUrl: 'http://127.0.0.1:43199', token: 'reader-token', fetchImpl: async () => { throw new Error('Must not fetch'); } });
	await assert.rejects(client.askLogs({ projectId: 'app', question: 'tools' }, { signal: cancellation.signal }), { name: 'AbortError' });
});
