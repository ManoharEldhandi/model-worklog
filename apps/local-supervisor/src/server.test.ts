import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';

import { parseHealthResponse } from 'model-worklog-schema';

import { startSupervisor, type RunningSupervisor, type StartOptions } from './server';
import type { CodexRelayFactory } from './codexRelay';

const running: RunningSupervisor[] = [];
const temporaryDirectories: string[] = [];
const runFile = promisify(execFile);

async function temporaryDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	temporaryDirectories.push(directory);
	return directory;
}

async function start(options: Pick<StartOptions, 'codexRelayFactory'> = {}): Promise<RunningSupervisor> {
	const supervisor = await startSupervisor({
		version: '0.1.0', host: '127.0.0.1', port: 0, dataDirectory: await temporaryDirectory('model-worklog-supervisor-'), authToken: 'test-token', ...options,
	});
	running.push(supervisor);
	return supervisor;
}

after(async () => {
	await Promise.all(running.map((supervisor) => supervisor.close()));
	await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

async function api(supervisor: RunningSupervisor, path: string, method = 'GET', body?: unknown, token = supervisor.authToken): Promise<Response> {
	return fetch(new URL(path, supervisor.url), {
		method,
		headers: { 'content-type': 'application/json', 'x-model-worklog-token': token },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function waitForTerminalSession(supervisor: RunningSupervisor, sessionId: string): Promise<{ state: string }> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const response = await api(supervisor, `/v1/sessions/${sessionId}`);
		const payload = await response.json() as { session: { state: string } };
		if (payload.session.state !== 'running') {
			return payload.session;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`session ${sessionId} did not become terminal`);
}

async function git(workspacePath: string, args: readonly string[]): Promise<void> {
	await runFile('git', ['-C', workspacePath, ...args]);
}

test('binds to an ephemeral loopback port and serves valid health', async () => {
	const supervisor = await start();
	assert.equal(supervisor.host, '127.0.0.1');
	assert.ok(supervisor.port > 0);

	const response = await fetch(new URL('/health', supervisor.url));
	assert.equal(response.status, 200);
	assert.match(response.headers.get('content-type') ?? '', /application\/json/);

	const parsed = parseHealthResponse(await response.json());
	assert.equal(parsed.ok, true);
	if (parsed.ok) {
		assert.equal(parsed.value.instanceId, supervisor.instanceId);
		assert.equal(parsed.value.status, 'ok');
	}
});

test('unknown path returns 404 over the socket', async () => {
	const supervisor = await start();
	const response = await fetch(new URL('/nope', supervisor.url), { headers: { 'x-model-worklog-token': supervisor.authToken } });
	assert.equal(response.status, 404);
});

test('POST /health returns 405 over the socket', async () => {
	const supervisor = await start();
	const response = await fetch(new URL('/health', supervisor.url), { method: 'POST' });
	assert.equal(response.status, 405);
});

test('refuses to bind to a non-loopback host', async () => {
	await assert.rejects(() => startSupervisor({ host: '0.0.0.0', port: 0 }), /non-loopback/);
});

test('close is idempotent enough to allow re-binding a fresh instance', async () => {
	const supervisor = await start();
	await supervisor.close();
	const next = await start();
	const response = await fetch(new URL('/health', next.url));
	assert.equal(response.status, 200);
});

test('refuses concurrent supervisors for one evidence directory and releases ownership on close', async () => {
	const dataDirectory = await temporaryDirectory('model-worklog-exclusive-store-');
	const first = await startSupervisor({ host: '127.0.0.1', port: 0, dataDirectory, authToken: 'test-token' });
	running.push(first);
	await assert.rejects(
		() => startSupervisor({ host: '127.0.0.1', port: 0, dataDirectory, authToken: 'test-token' }),
		/already owns/,
	);
	await first.close();
	const replacement = await startSupervisor({ host: '127.0.0.1', port: 0, dataDirectory, authToken: 'test-token' });
	running.push(replacement);
	assert.equal((await fetch(new URL('/health', replacement.url))).status, 200);
});

test('requires authentication and explicit trust before a managed command can run', async () => {
	const supervisor = await start();
	const workspacePath = await temporaryDirectory('model-worklog-workspace-');
	const unauthenticated = await fetch(new URL('/v1/sessions', supervisor.url));
	assert.equal(unauthenticated.status, 401);

	const untrusted = await api(supervisor, '/v1/runs', 'POST', { workspacePath, executable: process.execPath, args: ['-e', 'process.exit(0)'] });
	assert.equal(untrusted.status, 403);

	const trusted = await api(supervisor, '/v1/workspaces/trust', 'POST', { workspacePath });
	assert.equal(trusted.status, 200);
	const beforeRun = await api(supervisor, '/v1/sessions');
	assert.deepEqual((await beforeRun.json() as { sessions: unknown[] }).sessions, []);
});

test('captures a trusted process as redacted canonical evidence and records the usage gap', async () => {
	const supervisor = await start();
	const workspacePath = await temporaryDirectory('model-worklog-workspace-');
	assert.equal((await api(supervisor, '/v1/workspaces/trust', 'POST', { workspacePath })).status, 200);

	const run = await api(supervisor, '/v1/runs', 'POST', {
		workspacePath,
		executable: process.execPath,
		args: ['-e', 'process.stdout.write("apiKey=super-secret-value"); process.stderr.write("diagnostic output")'],
		actor: 'managed-demo',
	});
	assert.equal(run.status, 202);
	const payload = await run.json() as { session: { sessionId: string } };
	const terminal = await waitForTerminalSession(supervisor, payload.session.sessionId);
	assert.equal(terminal.state, 'completed');
	const completedSession = await api(supervisor, `/v1/sessions/${payload.session.sessionId}`);
	assert.deepEqual((await completedSession.json() as { session: { tokenUsage: unknown } }).session.tokenUsage, { status: 'unknown', reason: 'unsupported-capability' });

	const eventsResponse = await api(supervisor, `/v1/sessions/${payload.session.sessionId}/events`);
	const events = (await eventsResponse.json() as { events: { sequence: number; kind: string; evidenceGrade: string; unknownReason?: string; payload: unknown }[] }).events;
	assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7, 8]);
	assert.deepEqual(events.map((event) => event.kind), ['session.started', 'process.started', 'process.output', 'process.output', 'workspace.diff', 'process.completed', 'usage.unavailable', 'session.completed']);
	assert.equal(events.some((event) => JSON.stringify(event.payload).includes('super-secret-value')), false);
	assert.equal(events.some((event) => JSON.stringify(event.payload).includes('[REDACTED]')), true);
	const usageGap = events.find((event) => event.kind === 'usage.unavailable');
	assert.equal(usageGap?.evidenceGrade, 'unknown');
	assert.equal(usageGap?.unknownReason, 'unsupported-capability');
});

test('captures a redacted Git diff around a trusted managed command', async () => {
	const supervisor = await start();
	const workspacePath = await temporaryDirectory('model-worklog-git-workspace-');
	await git(workspacePath, ['init']);
	await git(workspacePath, ['config', 'user.email', 'test@example.com']);
	await git(workspacePath, ['config', 'user.name', 'Test User']);
	await writeFile(join(workspacePath, 'tracked.txt'), 'before\n', 'utf8');
	await git(workspacePath, ['add', 'tracked.txt']);
	await git(workspacePath, ['commit', '-m', 'initial']);
	await api(supervisor, '/v1/workspaces/trust', 'POST', { workspacePath });

	const run = await api(supervisor, '/v1/runs', 'POST', {
		workspacePath,
		executable: process.execPath,
		args: ['-e', 'require("node:fs").writeFileSync("tracked.txt", "apiKey=super-secret-value\\n")'],
	});
	const sessionId = (await run.json() as { session: { sessionId: string } }).session.sessionId;
	await waitForTerminalSession(supervisor, sessionId);
	const events = (await (await api(supervisor, `/v1/sessions/${sessionId}/events`)).json() as { events: { kind: string; evidenceGrade: string; payload: Record<string, unknown>; redaction: { replacements: number } }[] }).events;
	const diff = events.find((event) => event.kind === 'workspace.diff');
	assert.equal(diff?.evidenceGrade, 'observed-boundary');
	assert.deepEqual((diff?.payload.current as { paths?: unknown }).paths, ['tracked.txt']);
	assert.equal(diff?.payload.changedSinceStart, true);
	assert.equal(JSON.stringify(diff?.payload).includes('super-secret-value'), false);
	assert.equal(JSON.stringify(diff?.payload).includes('[REDACTED]'), true);
	assert.ok((diff?.redaction.replacements ?? 0) > 0);
});

test('accepts external model-declared events and aggregates reported token totals', async () => {
	const supervisor = await start();
	const workspacePath = await temporaryDirectory('model-worklog-workspace-');
	await api(supervisor, '/v1/workspaces/trust', 'POST', { workspacePath });
	const created = await api(supervisor, '/v1/sessions', 'POST', { workspacePath, actor: 'example-ai', runMode: 'observe' });
	assert.equal(created.status, 201);
	const session = (await created.json() as { session: { sessionId: string } }).session;

	const nativeClaim = await api(supervisor, `/v1/sessions/${session.sessionId}/events`, 'POST', {
		kind: 'tool.called', actor: 'example-ai', evidenceGrade: 'observed-native', payload: { tool: 'read_file' },
	});
	assert.equal(nativeClaim.status, 400);
	const declared = await api(supervisor, `/v1/sessions/${session.sessionId}/events`, 'POST', {
		kind: 'agent.summary', actor: 'example-ai', evidenceGrade: 'model-declared', payload: { summary: 'Read the requested file.' },
	});
	assert.equal(declared.status, 201);
	const usage = await api(supervisor, `/v1/sessions/${session.sessionId}/usage`, 'POST', { inputTokens: 12, outputTokens: 8, totalTokens: 20 });
	assert.equal(usage.status, 200);
	const completed = await api(supervisor, `/v1/sessions/${session.sessionId}/complete`, 'POST', {});
	const result = await completed.json() as { session: { state: string; tokenUsage: { status: string; totalTokens?: number } } };
	assert.equal(result.session.state, 'completed');
	assert.equal(result.session.tokenUsage.status, 'reported');
	assert.equal(result.session.tokenUsage.totalTokens, 20);
});

test('returns a versioned deterministic cost report for mapped provider usage', async () => {
	const supervisor = await start();
	const workspacePath = await temporaryDirectory('model-worklog-workspace-');
	await api(supervisor, '/v1/workspaces/trust', 'POST', { workspacePath });
	const created = await api(supervisor, '/v1/sessions', 'POST', { workspacePath, actor: 'cost-test', runMode: 'observe' });
	const sessionId = (await created.json() as { session: { sessionId: string } }).session.sessionId;
	await api(supervisor, `/v1/sessions/${sessionId}/usage`, 'POST', { source: 'provider-reported', provider: 'openai', model: 'gpt-5.6-terra', inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 100, totalTokens: 1_500 });
	const response = await api(supervisor, `/v1/sessions/${sessionId}/cost`);
	assert.equal(response.status, 200);
	const result = await response.json() as { sessionId: string; cost: { tableVersion: string; status: string; totalNanoUsd: string; totalUsd: string } };
	assert.equal(result.sessionId, sessionId);
	assert.deepEqual(result.cost, { tableVersion: 'builtin-2026-09-15', schemaVersion: 1, currency: 'USD', status: 'reported', totalNanoUsd: '7820000', totalUsd: '0.00782', lineItems: [{ sequence: 2, provider: 'openai', model: 'gpt-5.6-terra', status: 'priced', totalNanoUsd: '7820000', totalUsd: '0.00782' }] });
});

test('starts supervisor-owned Codex logger sessions and cancels active relays', async () => {
	let cancelCalls = 0;
	let first = true;
	const relayFactory: CodexRelayFactory = (sink, options, onFinished) => ({
		start: async (): Promise<void> => {
			if (!first) {
				return;
			}
			first = false;
			await sink.append({ kind: 'adapter.lifecycle', actor: 'codex-app-server', evidenceGrade: 'observed-native', payload: { phase: 'turn-started' } });
			await sink.recordUsage({ source: 'provider-reported', provider: 'openai', model: 'gpt-5.6-terra', inputTokens: 10, outputTokens: 5, totalTokens: 15 }, 'observed-native');
			await sink.complete('completed');
			onFinished(options.sessionId);
		},
		cancel: async (): Promise<void> => {
			cancelCalls += 1;
			await sink.complete('interrupted');
			onFinished(options.sessionId);
		},
		shutdown: async (): Promise<void> => {
			cancelCalls += 1;
			await sink.complete('interrupted');
			onFinished(options.sessionId);
		},
	});
	const supervisor = await start({ codexRelayFactory: relayFactory });
	const workspacePath = await temporaryDirectory('model-worklog-codex-workspace-');
	await api(supervisor, '/v1/workspaces/trust', 'POST', { workspacePath });
	const firstRun = await api(supervisor, '/v1/codex-sessions', 'POST', {
		workspacePath,
		task: 'Summarize the verified change.',
		maxDurationMs: 5_000,
		maxTokens: 100,
	});
	assert.equal(firstRun.status, 202);
	const sessionId = (await firstRun.json() as { session: { sessionId: string } }).session.sessionId;
	const completed = await waitForTerminalSession(supervisor, sessionId);
	assert.equal(completed.state, 'completed');
	const events = (await (await api(supervisor, `/v1/sessions/${sessionId}/events`)).json() as { events: { kind: string; evidenceGrade: string; payload: Record<string, unknown> }[] }).events;
	assert.equal(events.find((event) => event.kind === 'usage.reported')?.evidenceGrade, 'observed-native');

	const secondRun = await api(supervisor, '/v1/codex-sessions', 'POST', { workspacePath, task: 'Wait for cancellation.' });
	const cancelledSessionId = (await secondRun.json() as { session: { sessionId: string } }).session.sessionId;
	const cancelled = await api(supervisor, `/v1/sessions/${cancelledSessionId}/cancel`, 'POST', {});
	assert.equal(cancelled.status, 202);
	assert.equal((await waitForTerminalSession(supervisor, cancelledSessionId)).state, 'interrupted');
	assert.equal(cancelCalls, 1);
});

test('marks unfinished sessions interrupted when a new supervisor recovers the evidence store', async () => {
	const dataDirectory = await temporaryDirectory('model-worklog-recovery-store-');
	const workspacePath = await temporaryDirectory('model-worklog-recovery-workspace-');
	const first = await startSupervisor({ host: '127.0.0.1', port: 0, dataDirectory, authToken: 'test-token' });
	await api(first, '/v1/workspaces/trust', 'POST', { workspacePath });
	const created = await api(first, '/v1/sessions', 'POST', { workspacePath, actor: 'recovery-test', runMode: 'observe' });
	const sessionId = (await created.json() as { session: { sessionId: string } }).session.sessionId;
	await first.close();
	const recovered = await startSupervisor({ host: '127.0.0.1', port: 0, dataDirectory, authToken: 'test-token' });
	running.push(recovered);
	const session = await api(recovered, `/v1/sessions/${sessionId}`);
	assert.equal((await session.json() as { session: { state: string } }).session.state, 'interrupted');
	const events = (await (await api(recovered, `/v1/sessions/${sessionId}/events`)).json() as { events: { kind: string; payload: Record<string, unknown> }[] }).events;
	assert.equal(events.at(-1)?.kind, 'session.interrupted');
	assert.ok(events.some((event) => event.kind === 'adapter.lifecycle' && event.payload.phase === 'interrupted-after-supervisor-restart'));
});

test('exports a redacted deterministic evidence bundle and detects tampering', async () => {
	const supervisor = await start();
	const workspacePath = await temporaryDirectory('model-worklog-export-workspace-');
	await api(supervisor, '/v1/workspaces/trust', 'POST', { workspacePath });
	const created = await api(supervisor, '/v1/sessions', 'POST', { workspacePath, actor: 'exporter', runMode: 'observe' });
	const sessionId = (await created.json() as { session: { sessionId: string } }).session.sessionId;
	await api(supervisor, `/v1/sessions/${sessionId}/events`, 'POST', {
		kind: 'agent.summary', actor: 'exporter', evidenceGrade: 'model-declared',
		payload: { sourcePath: `${workspacePath}/private.txt`, note: 'apiKey=super-secret-value' },
	});
	const response = await api(supervisor, `/v1/sessions/${sessionId}/evidence-bundle`);
	assert.equal(response.status, 200);
	const bundle = (await response.json() as { bundle: Record<string, unknown> }).bundle;
	assert.equal(JSON.stringify(bundle).includes(workspacePath), false);
	assert.equal(JSON.stringify(bundle).includes('super-secret-value'), false);
	assert.equal(JSON.stringify(bundle).includes('[PATH REDACTED]'), true);
	assert.equal(JSON.stringify(bundle).includes('[REDACTED]'), true);
	assert.deepEqual(bundle.workspaceDiffs, []);
	const valid = await api(supervisor, '/v1/evidence-bundles/verify', 'POST', { bundle });
	assert.deepEqual(await valid.json(), { schemaVersion: 1, verification: { schemaVersion: 1, valid: true } });
	const tampered = structuredClone(bundle) as { session: { actor: string } };
	tampered.session.actor = 'tampered';
	const invalid = await api(supervisor, '/v1/evidence-bundles/verify', 'POST', { bundle: tampered });
	assert.deepEqual(await invalid.json(), { schemaVersion: 1, verification: { schemaVersion: 1, valid: false, reason: 'content-hash-mismatch' } });
});

test('returns resumable and filtered committed event queries', async () => {
	const supervisor = await start();
	const workspacePath = await temporaryDirectory('model-worklog-workspace-');
	await api(supervisor, '/v1/workspaces/trust', 'POST', { workspacePath });
	const created = await api(supervisor, '/v1/sessions', 'POST', { workspacePath, actor: 'watcher', runMode: 'observe' });
	const sessionId = (await created.json() as { session: { sessionId: string } }).session.sessionId;
	await api(supervisor, `/v1/sessions/${sessionId}/events`, 'POST', { kind: 'tool.called', actor: 'watcher', evidenceGrade: 'model-declared', payload: { tool: 'read_file', path: 'src/app.ts' } });
	await api(supervisor, `/v1/sessions/${sessionId}/events`, 'POST', { kind: 'command.started', actor: 'watcher', evidenceGrade: 'model-declared', payload: { executable: 'npm', args: ['test'] } });
	await api(supervisor, `/v1/sessions/${sessionId}/events`, 'POST', { kind: 'file.changed', actor: 'watcher', evidenceGrade: 'model-declared', payload: { path: 'src/app.ts', operation: 'modified' } });

	const response = await api(supervisor, `/v1/sessions/${sessionId}/events?afterSequence=1&kind=command.started,file.changed&actor=watcher`);
	assert.equal(response.status, 200);
	const result = await response.json() as { events: { sequence: number; kind: string }[]; cursor: { afterSequence: number; nextSequence: number }; terminal: boolean };
	assert.deepEqual(result.events.map((event) => [event.sequence, event.kind]), [[3, 'command.started'], [4, 'file.changed']]);
	assert.deepEqual(result.cursor, { afterSequence: 1, nextSequence: 4 });
	assert.equal(result.terminal, false);

	const pathResponse = await api(supervisor, `/v1/sessions/${sessionId}/events?path=src/app`);
	const pathResult = await pathResponse.json() as { events: { kind: string }[] };
	assert.deepEqual(pathResult.events.map((event) => event.kind), ['tool.called', 'file.changed']);
	const commandResponse = await api(supervisor, `/v1/sessions/${sessionId}/events?command=npm%20test`);
	const commandResult = await commandResponse.json() as { events: { kind: string }[] };
	assert.deepEqual(commandResult.events.map((event) => event.kind), ['command.started']);
	const noMatchResponse = await api(supervisor, `/v1/sessions/${sessionId}/events?afterSequence=1&actor=another-actor`);
	const noMatchResult = await noMatchResponse.json() as { events: unknown[]; cursor: { nextSequence: number } };
	assert.deepEqual(noMatchResult.events, []);
	assert.equal(noMatchResult.cursor.nextSequence, 4);
});
