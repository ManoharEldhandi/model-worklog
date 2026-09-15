import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import type { EventDraft } from './ledger';
import { CodexAppServerRelay, type CodexChild } from './codexRelay';

class FakeCodexChild implements CodexChild {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	private readonly listeners = new Map<string, ((...argumentsValue: unknown[]) => void)[]>();
	killed = false;

	kill(): boolean {
		this.killed = true;
		return true;
	}

	once(event: 'error' | 'close', listener: (...argumentsValue: unknown[]) => void): unknown {
		this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
		return undefined;
	}

	send(message: unknown): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}

	exit(code = 0): void {
		for (const listener of this.listeners.get('close') ?? []) {
			listener(code, null);
		}
	}

	fail(error: Error): void {
		for (const listener of this.listeners.get('error') ?? []) {
			listener(error);
		}
	}

	hasListener(event: 'error' | 'close'): boolean {
		return (this.listeners.get(event)?.length ?? 0) > 0;
	}
}

class RecordingSink {
	readonly events: EventDraft[] = [];
	readonly usage: unknown[] = [];
	readonly states: string[] = [];

	async append(event: EventDraft): Promise<void> {
		this.events.push(event);
	}

	async recordUsage(usage: unknown): Promise<void> {
		this.usage.push(usage);
	}

	async complete(state: string): Promise<void> {
		this.states.push(state);
	}
}

async function eventually(assertion: () => void): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			assertion();
			return;
		} catch {
			await new Promise<void>((resolve) => setTimeout(resolve, 1));
		}
	}
	assertion();
}

function relay(child: FakeCodexChild, sink: RecordingSink): CodexAppServerRelay {
	return new CodexAppServerRelay(sink, {
		sessionId: 'ses_codex', workspacePath: '/workspace', task: 'Fix the failing test.', maxDurationMs: 60_000, maxTokens: 10,
	}, { spawnCodex: () => child });
}

test('runs a Codex App Server turn, retains visible evidence, and stops on a usage budget', async () => {
	const child = new FakeCodexChild();
	const sink = new RecordingSink();
	const outbound: Record<string, unknown>[] = [];
	let buffered = '';
	child.stdin.on('data', (chunk: Buffer) => {
		buffered += chunk.toString('utf8');
		for (;;) {
			const newline = buffered.indexOf('\n');
			if (newline < 0) {
				break;
			}
			const message = JSON.parse(buffered.slice(0, newline)) as Record<string, unknown>;
			buffered = buffered.slice(newline + 1);
			outbound.push(message);
			if (message.method === 'initialize') {
				child.send({ id: message.id, result: { platformOs: 'macos' } });
			} else if (message.method === 'thread/start') {
				child.send({ id: message.id, result: { thread: { id: 'thr_1' }, instructionSources: ['/workspace/AGENTS.md'] } });
			} else if (message.method === 'turn/start') {
				child.send({ id: message.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } });
			}
		}
	});
	const running = relay(child, sink);
	await running.start();
	assert.deepEqual(outbound.filter((message) => 'method' in message).map((message) => message.method), ['initialize', 'initialized', 'thread/start', 'turn/start']);

	child.send({ method: 'item/agentMessage/delta', params: { itemId: 'msg_1', delta: 'I will inspect the failing test.' } });
	child.send({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'reason_1', delta: 'Tracing the test setup.' } });
	child.send({ method: 'item/reasoning/textDelta', params: { itemId: 'reason_1', delta: 'private reasoning must not persist' } });
	child.send({ method: 'thread/tokenUsage/updated', params: { usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 } } });
	await eventually(() => assert.ok(outbound.some((message) => message.method === 'turn/interrupt')));
	child.send({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'interrupted' } } });
	await eventually(() => assert.deepEqual(sink.states, ['interrupted']));

	assert.ok(sink.events.some((event) => event.kind === 'agent.message' && event.evidenceGrade === 'observed-native'));
	assert.ok(sink.events.some((event) => event.kind === 'agent.summary' && event.payload.source === 'reasoning-summary'));
	assert.ok(sink.events.some((event) => event.kind === 'agent.summary' && event.evidenceGrade === 'unknown' && event.unknownReason === 'redacted'));
	assert.equal(JSON.stringify(sink.events).includes('private reasoning must not persist'), false);
	assert.ok(sink.events.some((event) => event.kind === 'adapter.lifecycle' && event.payload.phase === 'usage-budget-exceeded'));
	assert.equal(sink.usage.length, 1);
	assert.equal(child.killed, true);
});

test('records a failure when Codex exits before finishing its turn', async () => {
	const child = new FakeCodexChild();
	const sink = new RecordingSink();
	const running = relay(child, sink);
	void running.start().catch(() => undefined);
	await eventually(() => assert.equal(child.hasListener('close'), true));
	child.exit(127);
	await eventually(() => assert.deepEqual(sink.states, ['failed']));
	assert.ok(sink.events.some((event) => event.kind === 'adapter.lifecycle' && event.payload.phase === 'failed'));
});

test('records a durable failure when the Codex executable cannot start', async () => {
	const child = new FakeCodexChild();
	const sink = new RecordingSink();
	const running = relay(child, sink);
	void running.start().catch(() => undefined);
	await eventually(() => assert.equal(child.hasListener('error'), true));
	child.fail(new Error('spawn codex ENOENT'));
	await eventually(() => assert.deepEqual(sink.states, ['failed']));
	assert.ok(sink.events.some((event) => event.kind === 'adapter.lifecycle' && String(event.payload.message).includes('spawn codex ENOENT')));
});