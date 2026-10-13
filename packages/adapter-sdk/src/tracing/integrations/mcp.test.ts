import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TraceSpanSchema, type TraceSpan } from 'model-worklog-schema';

import { instrumentMcpClient, type McpClient } from '../../index';
import { createModelLogger } from '../logger';
import type { ModelLoggerOptions } from '../types';

function recordingLogger(overrides: Partial<ModelLoggerOptions> = {}) {
	const spans: TraceSpan[] = [];
	const logger = createModelLogger({
		projectId: 'test', serviceName: 'mcp-test', flushIntervalMs: 0,
		exporter: { export: async (batch) => { spans.push(...batch.spans); return { schemaVersion: 1, accepted: batch.spans.length, duplicates: 0 }; } },
		...overrides,
	});
	return { logger, spans };
}

function clientWith<Arguments extends unknown[], Result>(operation: (...args: Arguments) => Promise<Result>) {
	return {
		callTool: operation, listTools: operation, readResource: operation,
		listResources: operation, getPrompt: operation, listPrompts: operation,
	};
}

const methods: ReadonlyArray<readonly [keyof McpClient, string]> = [
	['callTool', 'tools/call'], ['listTools', 'tools/list'],
	['readResource', 'resources/read'], ['listResources', 'resources/list'],
	['getPrompt', 'prompts/get'], ['listPrompts', 'prompts/list'],
];

for (const [method, protocolMethod] of methods) {
	test(`MCP ${method} maps to ${protocolMethod} and preserves types, receiver, arguments, and result`, async () => {
		const { logger, spans } = recordingLogger();
		const request = { name: 'lookup', arguments: { query: 'input-only' } };
		const schema = { parse: (value: unknown) => value };
		const options = { signal: new AbortController().signal };
		const result = { content: [{ type: 'text', text: 'output-only' }] };
		let calls = 0;
		const client = clientWith(async function (this: unknown, first: typeof request, second: typeof schema, third: typeof options): Promise<typeof result> {
			assert.equal(this, client);
			assert.equal(first, request);
			assert.equal(second, schema);
			assert.equal(third, options);
			assert.equal(arguments.length, 3);
			calls += 1;
			return result;
		});
		const descriptors = Object.getOwnPropertyDescriptors(client);
		const wrapped: typeof client = instrumentMcpClient(client, logger, { serverName: 'local-tools' });
		assert.notEqual(wrapped, client);
		const detached = wrapped[method];
		assert.equal(detached, wrapped[method]);
		const returned: typeof result = await detached(request, schema, options);
		assert.equal(returned, result);
		assert.equal(calls, 1);
		assert.deepEqual(Object.getOwnPropertyDescriptors(client), descriptors);
		assert.equal((await logger.shutdown()).success, true);
		assert.equal(spans.length, 2);
		assert.deepEqual(spans.map((span) => span.state), ['running', 'completed']);
		for (const span of spans) {
			assert.equal(span.name, `mcp.${protocolMethod}`);
			assert.equal(span.kind, 'tool');
			assert.equal(span.attributes['mcp.method'], protocolMethod);
			assert.equal(span.attributes['mcp.server.name'], 'local-tools');
			assert.equal(span.attributes['tool.name'], method === 'callTool' ? 'lookup' : undefined);
			assert.equal(span.attributes.input, undefined);
			assert.equal(span.attributes.output, undefined);
			assert.ok(TraceSpanSchema.safeParse(span).success);
		}
		assert.equal(spans[0]?.spanId, spans[1]?.spanId);
		assert.equal(spans[0]?.traceId, spans[1]?.traceId);
		assert.doesNotMatch(JSON.stringify(spans), /input-only|output-only/);
	});
}

test('MCP optional arguments stay omitted and cached wrappers track replaced methods', async () => {
	const { logger, spans } = recordingLogger();
	const calls: unknown[][] = [];
	const client = clientWith(async (...args: unknown[]) => { calls.push(args); return 'original'; });
	const wrapped = instrumentMcpClient(client, logger, { serverName: 'local' });
	const first = wrapped.listTools;
	assert.equal(await first(), 'original');
	client.listTools = async (...args: unknown[]) => { calls.push(args); return 'replacement'; };
	assert.notEqual(wrapped.listTools, first);
	assert.equal(wrapped.listTools, wrapped.listTools);
	assert.equal(await wrapped.listTools(undefined), 'replacement');
	assert.deepEqual(calls, [[], [undefined]]);
	await logger.shutdown();
	assert.equal(spans.length, 4);
});

test('MCP leaves unrelated synchronous methods, async methods, symbols, and properties untraced', async () => {
	const { logger, spans } = recordingLogger();
	const failure = new Error('unrelated failure');
	const symbol = Symbol('method');
	class Client {
		#state = { connected: true };
		readonly metadata = { version: 1 };
		callTool = async () => this.#state;
		listTools = this.callTool;
		readResource = this.callTool;
		listResources = this.callTool;
		getPrompt = this.callTool;
		listPrompts = this.callTool;
		get state() { return this.#state; }
		set state(value: { connected: boolean }) { this.#state = value; }
		synchronous() { return this.#state; }
		async unrelated() { return this.#state; }
		fail() { throw failure; }
		[symbol]() { return this.#state; }
	}
	const client = new Client();
	const wrapped = instrumentMcpClient(client, logger, { serverName: 'local' });
	assert.ok(wrapped instanceof Client);
	assert.equal(wrapped.constructor, Client);
	assert.equal(wrapped.metadata, client.metadata);
	assert.deepEqual(Reflect.ownKeys(wrapped), Reflect.ownKeys(client));
	assert.equal(wrapped.state, client.state);
	const detached = wrapped.synchronous;
	assert.equal(detached, wrapped.synchronous);
	assert.equal(detached(), client.state);
	assert.equal(wrapped[symbol], wrapped[symbol]);
	assert.equal(wrapped[symbol](), client.state);
	assert.equal(wrapped.unrelated, wrapped.unrelated);
	assert.equal(await wrapped.unrelated(), client.state);
	assert.throws(() => wrapped.fail(), (error) => error === failure);
	const next = { connected: false };
	wrapped.state = next;
	assert.equal(client.state, next);
	assert.equal(detached(), next);
	await logger.shutdown();
	assert.deepEqual(spans, []);
});

for (const synchronous of [true, false]) {
	test(`MCP preserves ${synchronous ? 'synchronously thrown' : 'rejected'} application errors despite hostile input`, async () => {
		const { logger, spans } = recordingLogger({ privacy: { mode: 'redacted-content' } });
		const failure = { message: 'application-secret' };
		const request = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error('metadata-secret'); } });
		let calls = 0;
		const client = clientWith((input: object): Promise<never> => {
			assert.equal(input, request);
			calls += 1;
			if (synchronous) { throw failure; }
			return Promise.reject(failure);
		});
		await assert.rejects(instrumentMcpClient(client, logger, { serverName: 'local' }).callTool(request), (error) => error === failure);
		assert.equal(calls, 1);
		await logger.shutdown();
		assert.equal(spans.at(-1)?.state, 'failed');
		assert.doesNotMatch(JSON.stringify(spans), /application-secret|metadata-secret/);
	});
}

test('MCP content is opt-in and secrets and reasoning are removed before export without mutating payloads', async () => {
	for (const mode of ['metadata', 'redacted-content'] as const) {
		const { logger, spans } = recordingLogger({ privacy: { mode } });
		let accessorReads = 0;
		const request = {
			name: 'lookup', arguments: { text: 'visible-input', password: 'input-secret', reasoning_content: 'private-input-reasoning' },
			get extra() { accessorReads += 1; throw new Error('accessor-secret'); },
		};
		const result = {
			content: [{ type: 'text', text: 'visible-output Bearer output-secret' }],
			apiKey: 'key-secret', reasoning: 'private-output-reasoning',
		};
		const client = clientWith(async (input: typeof request) => { assert.equal(input, request); return result; });
		assert.equal(await instrumentMcpClient(client, logger, { serverName: 'local' }).callTool(request), result);
		await logger.shutdown();
		assert.equal(accessorReads, 0);
		assert.equal(request.arguments.password, 'input-secret');
		assert.equal(result.apiKey, 'key-secret');
		assert.equal(result.reasoning, 'private-output-reasoning');
		assert.equal(Object.isFrozen(result), false);
		const final = spans.at(-1);
		assert.ok(final);
		const serialized = JSON.stringify(spans);
		assert.doesNotMatch(serialized, /input-secret|output-secret|key-secret|accessor-secret|private-input-reasoning|private-output-reasoning/);
		if (mode === 'metadata') {
			assert.equal(final.attributes.input, undefined);
			assert.equal(final.attributes.output, undefined);
			assert.doesNotMatch(serialized, /visible-input|visible-output/);
		} else {
			assert.match(serialized, /visible-input/);
			assert.match(serialized, /visible-output/);
			assert.match(serialized, /\[REDACTED\]/);
			assert.ok(Object.isFrozen(final.attributes.input));
			assert.ok(Object.isFrozen(final.attributes.output));
		}
	}
});

test('MCP labels use shared bounds and redaction and tool name accessors are never invoked', async () => {
	const { logger, spans } = recordingLogger();
	let nameReads = 0;
	const request = { get name() { nameReads += 1; throw new Error('name-secret'); } };
	const client = clientWith(async (input: object) => input);
	await instrumentMcpClient(client, logger, { serverName: `Bearer server-secret ${'x'.repeat(200)}` }).callTool(request);
	await instrumentMcpClient(client, logger, { serverName: '   ' }).callTool({ name: `token=tool-secret ${'y'.repeat(300)}` });
	await logger.shutdown();
	assert.equal(nameReads, 0);
	assert.equal(spans[0]?.attributes['mcp.server.name'], `Bearer [REDACTED] ${'x'.repeat(110)}`);
	assert.equal(spans[0]?.attributes['tool.name'], undefined);
	assert.equal(spans[2]?.attributes['mcp.server.name'], 'mcp');
	assert.equal(spans[2]?.attributes['tool.name'], `token=[REDACTED] ${'y'.repeat(239)}`);
	assert.doesNotMatch(JSON.stringify(spans), /server-secret|tool-secret|name-secret/);
});

test('MCP exporter and serialization failures never replace application results or errors', async () => {
	const { logger } = recordingLogger({
		privacy: { mode: 'redacted-content' },
		onDiagnostic: () => { throw new Error('diagnostic-secret'); },
		exporter: { export: async () => { throw new Error('export-secret'); } },
	});
	const result = new Proxy({}, { ownKeys: () => { throw new Error('result-secret'); } });
	const failure = new Error('original error');
	let calls = 0;
	const client = clientWith(async (fail: boolean) => { calls += 1; if (fail) { throw failure; } return result; });
	const wrapped = instrumentMcpClient(client, logger, { serverName: 'local' });
	assert.equal(await wrapped.callTool(false), result);
	await assert.rejects(wrapped.callTool(true), (error) => error === failure);
	assert.equal(calls, 2);
	assert.equal((await logger.shutdown()).success, false);
});

test('MCP calls inherit context at invocation and isolate concurrent nested spans', async () => {
	const { logger, spans } = recordingLogger();
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	let calls = 0;
	const client = clientWith(async (request: { name: string }) => {
		calls += 1;
		const context = logger.currentContext();
		assert.ok(context);
		if (request.name === 'right') { release?.(); }
		await gate;
		assert.equal(logger.currentContext(), context);
		return logger.trace({ name: `nested.${request.name}` }, async () => request);
	});
	const callTool = instrumentMcpClient(client, logger, { serverName: 'local' }).callTool;
	await Promise.all(['left', 'right'].map((name) => logger.trace({ name: `root.${name}`, kind: 'agent' }, async (root) => {
		const request = { name };
		assert.equal(await callTool(request), request);
		assert.equal(logger.currentContext(), root.context);
	})));
	assert.equal(calls, 2);
	assert.equal(logger.currentContext(), undefined);
	await logger.shutdown();
	const finals = spans.filter((span) => span.state === 'completed');
	assert.equal(finals.length, 6);
	assert.equal(new Set(finals.map((span) => span.spanId)).size, 6);
	for (const name of ['left', 'right']) {
		const root = finals.find((span) => span.name === `root.${name}`);
		const mcp = finals.find((span) => span.attributes['tool.name'] === name);
		const nested = finals.find((span) => span.name === `nested.${name}`);
		assert.ok(root && mcp && nested);
		assert.equal(root.parentSpanId, undefined);
		assert.equal(mcp.parentSpanId, root.spanId);
		assert.equal(nested.parentSpanId, mcp.spanId);
		assert.equal(mcp.traceId, root.traceId);
		assert.equal(nested.traceId, root.traceId);
	}
	assert.notEqual(finals.find((span) => span.name === 'root.left')?.traceId, finals.find((span) => span.name === 'root.right')?.traceId);
});