import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import type { EventDraft } from './ledger';
import { CopilotCliRelay, copilotTelemetryUsage, type CopilotChild } from './copilotRelay';

class FakeCopilotChild implements CopilotChild {
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

	send(event: unknown): void {
		this.stdout.write(`${JSON.stringify(event)}\n`);
	}

	exit(code = 0): void {
		for (const listener of this.listeners.get('close') ?? []) {
			listener(code, null);
		}
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

test('runs a Copilot CLI task with documented streams and retains visible native agent activity', async () => {
	const child = new FakeCopilotChild();
	const sink = new RecordingSink();
	let command: string | undefined;
	let argumentsValue: readonly string[] = [];
	const relay = new CopilotCliRelay(sink, {
		sessionId: 'ses_copilot', workspacePath: '/workspace', task: 'Fix the failing test.', maxDurationMs: 60_000,
	}, {
		spawnCopilot: (receivedCommand, receivedArguments) => {
			command = receivedCommand;
			argumentsValue = receivedArguments;
			return child;
		},
	});
	await relay.start();
	assert.equal(command, 'copilot');
	assert.deepEqual(argumentsValue, ['--prompt', 'Fix the failing test.', '--output-format', 'json', '--stream', 'on', '--allow-all-tools', '--no-color']);

	child.send({ type: 'user.message', data: { turnId: 'turn-1', content: 'Fix the failing test.' } });
	child.send({ type: 'assistant.message', data: { turnId: 'turn-1', content: 'I will inspect the test.' } });
	child.send({ type: 'assistant.reasoning', data: { turnId: 'turn-1', content: 'private reasoning' } });
	child.send({ type: 'tool.execution_start', data: { turnId: 'turn-1', toolCallId: 'tool-1', toolName: 'read_file', arguments: { path: '/workspace/src/app.ts' } } });
	child.send({ type: 'tool.execution_complete', data: { turnId: 'turn-1', toolCallId: 'tool-1', success: true, result: { lines: 10 } } });
	child.send({ type: 'result', exitCode: 0 });
	child.exit(0);
	await eventually(() => assert.deepEqual(sink.states, ['completed']));

	assert.ok(sink.events.some((event) => event.kind === 'agent.message' && event.actor === 'copilot-cli' && event.evidenceGrade === 'observed-native' && event.payload.text === 'I will inspect the test.'));
	assert.ok(sink.events.some((event) => event.kind === 'tool.called' && event.evidenceGrade === 'observed-native' && event.payload.tool === 'read_file'));
	assert.ok(sink.events.some((event) => event.kind === 'tool.completed' && event.payload.result !== undefined));
	assert.ok(sink.events.some((event) => event.kind === 'agent.summary' && event.evidenceGrade === 'unknown' && event.unknownReason === 'redacted'));
	assert.equal(JSON.stringify(sink.events).includes('private reasoning'), false);
});

test('normalizes provider-reported token usage from documented Copilot chat spans', () => {
	const usage = copilotTelemetryUsage(`${JSON.stringify({
		type: 'span', name: 'chat gpt-example', attributes: {
			'gen_ai.provider.name': 'openai',
			'gen_ai.response.model': 'gpt-example',
			'gen_ai.usage.input_tokens': 120,
			'gen_ai.usage.output_tokens': 30,
			'gen_ai.usage.cache_read.input_tokens': 40,
			'gen_ai.usage.reasoning.output_tokens': 8,
		},
	})}\n${JSON.stringify({ type: 'metric', name: 'gen_ai.client.token.usage' })}`);
	assert.deepEqual(usage, [{
		source: 'provider-reported', provider: 'openai', model: 'gpt-example', inputTokens: 120, outputTokens: 30,
		cacheReadTokens: 40, reasoningTokens: 8, totalTokens: 150,
	}]);
});