import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LocalSupervisorClient } from './index';

function sessionBody(): Record<string, unknown> {
	return {
		schemaVersion: 1, sessionId: 'ses_sdk', runMode: 'observe', state: 'running', actor: 'example-ai',
		workspace: { label: 'workspace', fingerprint: 'fingerprint' }, createdAt: '2026-09-15T10:00:00.000Z', eventCount: 1,
		tokenUsage: { status: 'unknown', reason: 'not-observed' },
	};
}

test('rejects a remote supervisor URL', () => {
	assert.throws(() => new LocalSupervisorClient({ supervisorUrl: 'https://example.com', token: 'secret' }), /loopback/);
});

test('emits declared activity and reported usage through the local protocol', async () => {
	const requests: { path: string; body: Record<string, unknown>; headers?: Record<string, string> }[] = [];
	const client = new LocalSupervisorClient({
		supervisorUrl: 'http://127.0.0.1:43199',
		token: 'local-token',
		fetchImpl: async (input, init) => {
			requests.push({ path: new URL(input).pathname, body: JSON.parse(init?.body ?? '{}') as Record<string, unknown>, headers: init?.headers });
			const path = new URL(input).pathname;
			if (path === '/v1/sessions') {
				return new Response(JSON.stringify({ session: sessionBody() }), { status: 201 });
			}
			if (path.endsWith('/usage')) {
				return new Response(JSON.stringify({ session: { ...sessionBody(), tokenUsage: { status: 'reported', source: 'provider-reported', providers: ['openai'], models: ['gpt-5'], inputTokens: 4, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 7 } } }), { status: 200 });
			}
			if (path.endsWith('/complete')) {
				return new Response(JSON.stringify({ session: { ...sessionBody(), state: 'completed' } }), { status: 200 });
			}
			return new Response(JSON.stringify({ event: { sequence: 2 } }), { status: 201 });
		},
	});
	const session = await client.startSession({ workspacePath: '/workspace', actor: 'example-ai' });
	await session.summary('Read the requested file.');
	await session.toolCalled({ tool: 'read_file', arguments: { path: 'README.md' }, correlationId: 'tool_1' });
	const providerUsage = await session.reportProviderUsage('openai', { id: 'resp_123', model: 'gpt-5', usage: { input_tokens: 4, output_tokens: 3, total_tokens: 7 } });
	await session.complete();

	assert.equal(requests[0]?.headers?.['x-model-worklog-token'], 'local-token');
	assert.deepEqual(requests.map((request) => request.path), ['/v1/sessions', '/v1/sessions/ses_sdk/events', '/v1/sessions/ses_sdk/events', '/v1/sessions/ses_sdk/usage', '/v1/sessions/ses_sdk/complete']);
	assert.deepEqual(requests[1]?.body, { kind: 'agent.summary', actor: 'example-ai', evidenceGrade: 'model-declared', payload: { summary: 'Read the requested file.' } });
	assert.equal(requests[2]?.body.evidenceGrade, 'model-declared');
	assert.equal(requests[2]?.body.correlationId, 'tool_1');
	assert.equal(providerUsage.normalized.ok, true);
	assert.equal(providerUsage.session?.tokenUsage.status, 'reported');
	assert.deepEqual(requests[3]?.body, { source: 'provider-reported', provider: 'openai', model: 'gpt-5', providerResponseId: 'resp_123', inputTokens: 4, outputTokens: 3, totalTokens: 7 });
});