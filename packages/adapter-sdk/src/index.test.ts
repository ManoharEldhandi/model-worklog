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
	assert.throws(() => new LocalSupervisorClient({ supervisorUrl: 'https://127.0.0.1:43199', token: 'secret' }), /loopback HTTP/);
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

test('records visible summaries and tool lifecycle around a generic operation', async () => {
	const requests: { readonly path: string; readonly body: Record<string, unknown> }[] = [];
	const client = new LocalSupervisorClient({
		supervisorUrl: 'http://127.0.0.1:43199',
		token: 'local-token',
		fetchImpl: async (input, init) => {
			const path = new URL(input).pathname;
			const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>;
			requests.push({ path, body });
			return path === '/v1/sessions'
				? new Response(JSON.stringify({ session: sessionBody() }), { status: 201 })
				: new Response(JSON.stringify({ event: { sequence: requests.length } }), { status: 201 });
		},
	});
	const session = await client.startSession({ workspacePath: '/workspace', actor: 'generic-agent', title: 'Inspect parser task' });
	await session.userMessage('Inspect the parser.');
	await session.plan('Read the parser and its test before editing.', ['Read source', 'Read test', 'Summarize finding']);
	await session.reasoningSummary('The failure likely comes from an outdated expected value.');
	const result = await session.runTool({ tool: 'read_file', arguments: { path: 'src/parser.ts' }, correlationId: 'tool_read_1' }, async () => ({ linesRead: 84 }));
	assert.deepEqual(result, { linesRead: 84 });
	assert.deepEqual(requests.slice(1).map((request) => request.body), [
		{ kind: 'agent.message', actor: 'generic-agent', evidenceGrade: 'model-declared', payload: { text: 'Inspect the parser.', role: 'user' } },
		{ kind: 'agent.summary', actor: 'generic-agent', evidenceGrade: 'model-declared', payload: { summary: 'Read the parser and its test before editing.', source: 'plan', plan: ['Read source', 'Read test', 'Summarize finding'] } },
		{ kind: 'agent.summary', actor: 'generic-agent', evidenceGrade: 'model-declared', payload: { summary: 'The failure likely comes from an outdated expected value.', source: 'reasoning-summary' } },
		{ kind: 'tool.called', actor: 'generic-agent', evidenceGrade: 'model-declared', payload: { tool: 'read_file', arguments: { path: 'src/parser.ts' } }, correlationId: 'tool_read_1' },
		{ kind: 'tool.completed', actor: 'generic-agent', evidenceGrade: 'model-declared', payload: { tool: 'read_file', success: true, result: { linesRead: 84 } }, correlationId: 'tool_read_1' },
	]);
	assert.deepEqual(requests[0]?.body, { workspacePath: '/workspace', actor: 'generic-agent', runMode: 'observe', title: 'Inspect parser task' });
});

test('records a tool failure before rethrowing the original error', async () => {
	const requests: { readonly body: Record<string, unknown> }[] = [];
	const client = new LocalSupervisorClient({
		supervisorUrl: 'http://127.0.0.1:43199',
		token: 'local-token',
		fetchImpl: async (input, init) => {
			requests.push({ body: JSON.parse(init?.body ?? '{}') as Record<string, unknown> });
			return new URL(input).pathname === '/v1/sessions'
				? new Response(JSON.stringify({ session: sessionBody() }), { status: 201 })
				: new Response(JSON.stringify({ event: { sequence: requests.length } }), { status: 201 });
		},
	});
	const session = await client.startSession({ workspacePath: '/workspace', actor: 'generic-agent' });
	await assert.rejects(
		() => session.runTool({ tool: 'read_file', correlationId: 'tool_read_2' }, async () => { throw new Error('file was not found'); }),
		/file was not found/,
	);
	assert.deepEqual(requests.at(-1)?.body, {
		kind: 'tool.completed', actor: 'generic-agent', evidenceGrade: 'model-declared',
		payload: { tool: 'read_file', success: false, error: 'file was not found' }, correlationId: 'tool_read_2',
	});
});

test('follows committed events until a session becomes terminal', async () => {
	let eventRequests = 0;
	const client = new LocalSupervisorClient({
		supervisorUrl: 'http://127.0.0.1:43199',
		token: 'local-token',
		fetchImpl: async (input) => {
			const url = new URL(input);
			if (url.pathname === '/v1/sessions') {
				return new Response(JSON.stringify({ session: sessionBody() }), { status: 201 });
			}
			eventRequests += 1;
			const event = eventRequests === 1
				? { schemaVersion: 1, eventId: 'evt_2', sessionId: 'ses_sdk', sequence: 2, occurredAt: '2026-09-15T10:00:01.000Z', kind: 'agent.summary', actor: 'example-ai', evidenceGrade: 'model-declared', payload: { summary: 'Checking the parser.' }, redaction: { policyVersion: '1', replacements: 0, truncated: false } }
				: { schemaVersion: 1, eventId: 'evt_3', sessionId: 'ses_sdk', sequence: 3, occurredAt: '2026-09-15T10:00:02.000Z', kind: 'session.completed', actor: 'supervisor', evidenceGrade: 'computed', payload: { state: 'completed' }, redaction: { policyVersion: '1', replacements: 0, truncated: false } };
			return new Response(JSON.stringify({ events: [event], cursor: { afterSequence: eventRequests === 1 ? 0 : 2, nextSequence: eventRequests + 1 }, terminal: eventRequests === 2 }), { status: 200 });
		},
	});
	const session = await client.startSession({ workspacePath: '/workspace', actor: 'example-ai' });
	const received: string[] = [];
	await session.followEvents((event) => {
		received.push(event.kind);
	}, { intervalMs: 25 });
	assert.deepEqual(received, ['agent.summary', 'session.completed']);
	assert.equal(eventRequests, 2);
});