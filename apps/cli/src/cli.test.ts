import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runCli } from './cli';
import { ExitCode } from './constants';
import type { OutputStream } from './output';
import type { FetchLike } from './protocolClient';

class Capture implements OutputStream {
	data = '';
	readonly isTTY?: boolean;
	constructor(isTTY?: boolean) {
		this.isTTY = isTTY;
	}
	write(chunk: string): boolean {
		this.data += chunk;
		return true;
	}
}

function validHealthBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		status: 'ok',
		supervisorVersion: '0.1.0',
		apiVersion: '1.0',
		schemaVersion: 1,
		instanceId: 'sup_abc',
		startedAt: '2026-09-11T14:00:00.000Z',
		capabilities: { adapters: [], features: ['health'] },
		...overrides,
	};
}

function validSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		sessionId: 'ses_demo',
		runMode: 'managed',
		state: 'completed',
		actor: 'demo-agent',
		workspace: { label: 'workspace', fingerprint: 'abc123' },
		createdAt: '2026-09-15T10:00:00.000Z',
		completedAt: '2026-09-15T10:01:00.000Z',
		eventCount: 3,
		tokenUsage: { status: 'reported', source: 'provider-reported', providers: ['openai'], models: ['gpt-5'], inputTokens: 12, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 3, totalTokens: 20 },
		...overrides,
	};
}

function validEvent(sequence: number, kind: string, payload: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		schemaVersion: 1,
		eventId: `evt_${sequence}`,
		sessionId: 'ses_demo',
		sequence,
		occurredAt: `2026-09-15T10:00:0${sequence}.000Z`,
		kind,
		actor: 'demo-agent',
		evidenceGrade: 'model-declared',
		payload,
		redaction: { policyVersion: '1', replacements: 0, truncated: false },
		...overrides,
	};
}

function jsonFetch(body: unknown, status = 200): FetchLike {
	return async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
}

const unreachableFetch: FetchLike = async () => {
	throw new Error('connect ECONNREFUSED');
};

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

async function run(argv: string[], fetchImpl?: FetchLike, env: NodeJS.ProcessEnv = {}, isTTY = false): Promise<RunResult> {
	const stdout = new Capture(isTTY);
	const stderr = new Capture(isTTY);
	const code = await runCli({ argv, env, stdout, stderr, fetchImpl });
	return { code, stdout: stdout.data, stderr: stderr.data };
}

test('no arguments prints help to stderr and returns InvalidInvocation', async () => {
	const result = await run([]);
	assert.equal(result.code, ExitCode.InvalidInvocation);
	assert.match(result.stderr, /Usage:/);
});

test('--help returns Ok and prints to stdout', async () => {
	const result = await run(['--help']);
	assert.equal(result.code, ExitCode.Ok);
	assert.match(result.stdout, /Usage:/);
});

test('--version prints the version', async () => {
	const result = await run(['--version']);
	assert.equal(result.code, ExitCode.Ok);
	assert.match(result.stdout, /0\.1\.0/);
});

test('unknown command returns InvalidInvocation', async () => {
	const result = await run(['frobnicate']);
	assert.equal(result.code, ExitCode.InvalidInvocation);
	assert.match(result.stderr, /Unknown command/);
});

test('invalid --format returns InvalidInvocation', async () => {
	const result = await run(['doctor', '--format', 'xml']);
	assert.equal(result.code, ExitCode.InvalidInvocation);
});

test('supervisor with no subcommand returns InvalidInvocation', async () => {
	const result = await run(['supervisor']);
	assert.equal(result.code, ExitCode.InvalidInvocation);
});

test('supervisor status ok returns Ok and emits JSON result', async () => {
	const result = await run(['supervisor', 'status', '--format', 'json'], jsonFetch(validHealthBody()));
	assert.equal(result.code, ExitCode.Ok);
	const parsed = JSON.parse(result.stdout) as { command: string; result: { status: string } };
	assert.equal(parsed.command, 'supervisor.status');
	assert.equal(parsed.result.status, 'ok');
});

test('supervisor status unreachable returns Unavailable', async () => {
	const result = await run(['supervisor', 'status'], unreachableFetch);
	assert.equal(result.code, ExitCode.Unavailable);
});

test('supervisor status incompatible returns Unavailable', async () => {
	const result = await run(['supervisor', 'status'], jsonFetch(validHealthBody({ apiVersion: '2.0' })));
	assert.equal(result.code, ExitCode.Unavailable);
});

test('supervisor status malformed returns Internal', async () => {
	const result = await run(['supervisor', 'status'], jsonFetch({ status: 'ok' }));
	assert.equal(result.code, ExitCode.Internal);
});

test('doctor returns Ok even when the supervisor is down', async () => {
	const result = await run(['doctor', '--format', 'json'], unreachableFetch);
	assert.equal(result.code, ExitCode.Ok);
	const parsed = JSON.parse(result.stdout) as { ok: boolean; checks: { name: string; status: string }[] };
	assert.equal(parsed.ok, true);
	const supervisor = parsed.checks.find((check) => check.name === 'supervisor');
	assert.equal(supervisor?.status, 'warn');
});

test('doctor --require-supervisor returns Unavailable when the supervisor is down', async () => {
	const result = await run(['doctor', '--require-supervisor'], unreachableFetch);
	assert.equal(result.code, ExitCode.Unavailable);
});

test('doctor reports a connected supervisor', async () => {
	const result = await run(['doctor', '--format', 'json'], jsonFetch(validHealthBody()));
	assert.equal(result.code, ExitCode.Ok);
	const parsed = JSON.parse(result.stdout) as { checks: { name: string; status: string }[] };
	const supervisor = parsed.checks.find((check) => check.name === 'supervisor');
	assert.equal(supervisor?.status, 'ok');
});

test('run sends an explicit executable and argument vector to the supervisor', async () => {
	let requestBody: unknown;
	const apiFetch: FetchLike = async (input, init) => {
		assert.equal(new URL(input).pathname, '/v1/runs');
		assert.equal(init?.headers?.['x-model-worklog-token'], 'test-token');
		requestBody = init?.body === undefined ? undefined : JSON.parse(init.body);
		return new Response(JSON.stringify({ schemaVersion: 1, session: validSession({ state: 'running', eventCount: 1 }) }), { status: 202 });
	};
	const result = await run(['run', '--format', 'json', '--actor', 'test-agent', '--', 'node', '-e', 'process.exit(0)'], apiFetch, { MODEL_WORKLOG_TOKEN: 'test-token' });
	assert.equal(result.code, ExitCode.Ok);
	assert.deepEqual(requestBody, {
		workspacePath: process.cwd(), executable: 'node', args: ['-e', 'process.exit(0)'], actor: 'test-agent',
	});
	assert.equal((JSON.parse(result.stdout) as { command: string }).command, 'run');
});

test('logs renders a readable timeline and one canonical event per JSONL line', async () => {
	const events = [
		validEvent(1, 'agent.summary', { summary: 'Read the requested file.' }),
		validEvent(2, 'tool.called', { tool: 'read_file', arguments: { path: 'README.md' } }),
		validEvent(3, 'usage.reported', { source: 'provider-reported', provider: 'openai', model: 'gpt-5', inputTokens: 12, outputTokens: 8, reasoningTokens: 3, totalTokens: 20 }),
	];
	const apiFetch: FetchLike = async (input) => {
		const path = new URL(input).pathname;
		if (path === '/v1/sessions/ses_demo') {
			return new Response(JSON.stringify({ schemaVersion: 1, session: validSession({ title: 'Fix parser test output' }) }), { status: 200 });
		}
		return new Response(JSON.stringify({ schemaVersion: 1, sessionId: 'ses_demo', events }), { status: 200 });
	};
	const pretty = await run(['logs', 'ses_demo', '--format', 'pretty'], apiFetch, { MODEL_WORKLOG_TOKEN: 'test-token' }, true);
	assert.equal(pretty.code, ExitCode.Ok);
	assert.match(pretty.stdout, /Log: Fix parser test output/);
	assert.match(pretty.stdout, /Session: ses_demo/);
	assert.match(pretty.stdout, /agent\.summary/);
	assert.match(pretty.stdout, /Read the requested file/);
	assert.match(pretty.stdout, /Tokens: 20 total/);
	assert.match(pretty.stdout, /provider-reported; providers openai; models gpt-5/);
	assert.match(pretty.stdout, /reasoning 3/);

	const jsonl = await run(['logs', 'ses_demo', '--format', 'jsonl'], apiFetch, { MODEL_WORKLOG_TOKEN: 'test-token' });
	assert.equal(jsonl.code, ExitCode.Ok);
	const lines = jsonl.stdout.trim().split('\n').map((line) => JSON.parse(line) as { sequence: number; kind: string });
	assert.deepEqual(lines.map((line) => line.sequence), [1, 2, 3]);
	assert.deepEqual(lines.map((line) => line.kind), ['agent.summary', 'tool.called', 'usage.reported']);
});

test('watch sends resumable filters and renders one committed event per JSONL line', async () => {
	let query: URLSearchParams | undefined;
	const apiFetch: FetchLike = async (input) => {
		const url = new URL(input);
		query = url.searchParams;
		return new Response(JSON.stringify({
			schemaVersion: 1, sessionId: 'ses_demo', terminal: false,
			cursor: { afterSequence: 2, nextSequence: 3 },
			events: [validEvent(3, 'file.changed', { path: 'src/app.ts', operation: 'modified' })],
		}), { status: 200 });
	};
	const result = await run(['watch', 'ses_demo', '--after-sequence', '2', '--kind', 'file.changed,command.completed', '--grade', 'model-declared', '--actor', 'demo-agent', '--path', 'src/app', '--command', 'npm test', '--once', '--format', 'jsonl'], apiFetch, { MODEL_WORKLOG_TOKEN: 'test-token' });
	assert.equal(result.code, ExitCode.Ok);
	assert.equal(query?.get('afterSequence'), '2');
	assert.deepEqual(query?.getAll('kind'), ['file.changed', 'command.completed']);
	assert.equal(query?.get('grade'), 'model-declared');
	assert.equal(query?.get('actor'), 'demo-agent');
	assert.equal(query?.get('path'), 'src/app');
	assert.equal(query?.get('command'), 'npm test');
	assert.deepEqual(JSON.parse(result.stdout) as { sequence: number; kind: string }, { ...validEvent(3, 'file.changed', { path: 'src/app.ts', operation: 'modified' }) });
});

test('cost renders a versioned provider cost report from the supervisor', async () => {
	const apiFetch: FetchLike = async (input) => {
		assert.equal(new URL(input).pathname, '/v1/sessions/ses_demo/cost');
		return new Response(JSON.stringify({
			sessionId: 'ses_demo',
			cost: { schemaVersion: 1, tableVersion: 'builtin-2026-09-15', currency: 'USD', status: 'partial', totalNanoUsd: '7820000', totalUsd: '0.00782', lineItems: [
				{ sequence: 4, provider: 'openai', model: 'gpt-5.6-terra', status: 'priced', totalNanoUsd: '7820000', totalUsd: '0.00782' },
				{ sequence: 5, provider: 'openai', model: 'future-model', status: 'unknown', reason: 'No rate is available.' },
			] },
		}), { status: 200 });
	};
	const result = await run(['cost', 'ses_demo', '--format', 'pretty'], apiFetch, { MODEL_WORKLOG_TOKEN: 'test-token' }, true);
	assert.equal(result.code, ExitCode.Ok);
	assert.match(result.stdout, /\$0\.00782 USD \(partial, builtin-2026-09-15\)/);
	assert.match(result.stdout, /openai\/gpt-5\.6-terra: \$0\.00782/);
	assert.match(result.stdout, /future-model: unknown \(No rate is available\.\)/);
});

test('export writes a supervisor-generated bundle and verify delegates manifest checking', async () => {
	const directory = await mkdtemp(join(tmpdir(), 'model-worklog-cli-export-'));
	const outputPath = join(directory, 'session.bundle.json');
	const bundle = { schemaVersion: 1, kind: 'model-worklog-evidence-bundle', manifest: { contentSha256: 'abc' } };
	try {
		await writeFile(outputPath, 'old export', { encoding: 'utf8', mode: 0o644 });
		if (process.platform !== 'win32') {
			await chmod(outputPath, 0o644);
		}
		let verifiedBundle: unknown;
		const apiFetch: FetchLike = async (input, init) => {
			const pathname = new URL(input).pathname;
			if (pathname === '/v1/sessions/ses_demo/evidence-bundle') {
				return new Response(JSON.stringify({ schemaVersion: 1, bundle }), { status: 200 });
			}
			assert.equal(pathname, '/v1/evidence-bundles/verify');
			verifiedBundle = JSON.parse(init?.body ?? '{}').bundle;
			return new Response(JSON.stringify({ schemaVersion: 1, verification: { schemaVersion: 1, valid: false, reason: 'content-hash-mismatch' } }), { status: 200 });
		};
		const exported = await run(['export', 'ses_demo', '--output', outputPath, '--format', 'json'], apiFetch, { MODEL_WORKLOG_TOKEN: 'test-token' });
		assert.equal(exported.code, ExitCode.Ok);
		assert.deepEqual(JSON.parse(await readFile(outputPath, 'utf8')), bundle);
		if (process.platform !== 'win32') {
			assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
		}
		assert.deepEqual(JSON.parse(exported.stdout) as { command: string; result: { outputPath: string } }, { schemaVersion: 1, command: 'export', result: { sessionId: 'ses_demo', outputPath } });
		const verified = await run(['verify', outputPath, '--format', 'json'], apiFetch, { MODEL_WORKLOG_TOKEN: 'test-token' });
		assert.equal(verified.code, ExitCode.Internal);
		assert.deepEqual(verifiedBundle, bundle);
		assert.deepEqual(JSON.parse(verified.stdout) as { result: { valid: boolean; reason: string } }, { schemaVersion: 1, command: 'verify', result: { inputPath: outputPath, valid: false, reason: 'content-hash-mismatch' } });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
