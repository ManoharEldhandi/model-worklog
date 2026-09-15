import { spawn, type SpawnOptions } from 'node:child_process';
import { basename, relative } from 'node:path';
import { createInterface, type Interface } from 'node:readline';

import { CodexAppServerAdapter } from 'model-worklog-sdk';
import { normalizeOpenAIUsage } from 'model-worklog-sdk';
import type { JsonObject, SessionState, TokenUsage } from 'model-worklog-schema';

import type { EventDraft } from './ledger';

const REQUEST_TIMEOUT_MS = 12_000;
const INTERRUPT_GRACE_MS = 3_000;

export interface CodexRelayOptions {
	readonly sessionId: string;
	readonly workspacePath: string;
	readonly task: string;
	readonly model?: string;
	readonly maxDurationMs: number;
	readonly maxTokens?: number;
}

export interface CodexRelaySink {
	append(draft: EventDraft): Promise<unknown>;
	recordUsage(usage: TokenUsage, evidenceGrade: 'observed-native'): Promise<unknown>;
	complete(state: Extract<SessionState, 'completed' | 'failed' | 'interrupted'>): Promise<unknown>;
}

export interface CodexChild {
	readonly stdin: NodeJS.WritableStream | null;
	readonly stdout: NodeJS.ReadableStream | null;
	readonly stderr: NodeJS.ReadableStream | null;
	kill(signal?: NodeJS.Signals): boolean;
	once(event: 'error' | 'close', listener: (...argumentsValue: unknown[]) => void): unknown;
}

export type SpawnCodex = (command: string, argumentsValue: readonly string[], options: SpawnOptions) => CodexChild;

export interface CodexRelayDependencies {
	readonly spawnCodex?: SpawnCodex;
	readonly now?: () => number;
	readonly onFinished?: (sessionId: string) => void;
}

export interface CodexRelayControl {
	start(): Promise<void>;
	cancel(reason?: string): Promise<void>;
	shutdown(): Promise<void>;
}

export type CodexRelayFactory = (
	sink: CodexRelaySink,
	options: CodexRelayOptions,
	onFinished: (sessionId: string) => void,
) => CodexRelayControl;

export const createCodexRelay: CodexRelayFactory = (sink, options, onFinished) => new CodexAppServerRelay(sink, options, { onFinished });

interface RpcResponse {
	readonly id?: number;
	readonly result?: unknown;
	readonly error?: { readonly message?: unknown };
	readonly method?: string;
	readonly params?: unknown;
}

interface PendingRequest {
	readonly resolve: (result: unknown) => void;
	readonly reject: (error: Error) => void;
	readonly timeout: ReturnType<typeof setTimeout>;
}

interface TokenSnapshot {
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly reasoningTokens: number;
	readonly totalTokens: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function relativePath(path: unknown, workspacePath: string): string | undefined {
	const source = stringValue(path);
	if (source === undefined) {
		return undefined;
	}
	const candidate = relative(workspacePath, source);
	return candidate !== '' && !candidate.startsWith('..') && !candidate.includes('/../') ? candidate : basename(source);
}

function tokenSnapshot(usage: TokenUsage): TokenSnapshot {
	return {
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0,
		reasoningTokens: usage.reasoningTokens ?? 0,
		totalTokens: usage.totalTokens ?? 0,
	};
}

function usageDelta(current: TokenUsage, previous: TokenSnapshot | undefined): TokenUsage | undefined {
	if (previous === undefined) {
		return current;
	}
	const snapshot = tokenSnapshot(current);
	if (Object.keys(snapshot).some((key) => snapshot[key as keyof TokenSnapshot] < previous[key as keyof TokenSnapshot])) {
		return undefined;
	}
	return {
		...current,
		inputTokens: snapshot.inputTokens - previous.inputTokens,
		outputTokens: snapshot.outputTokens - previous.outputTokens,
		cacheReadTokens: snapshot.cacheReadTokens - previous.cacheReadTokens,
		cacheWriteTokens: snapshot.cacheWriteTokens - previous.cacheWriteTokens,
		reasoningTokens: snapshot.reasoningTokens - previous.reasoningTokens,
		totalTokens: snapshot.totalTokens - previous.totalTokens,
	};
}

function terminalState(status: unknown): Extract<SessionState, 'completed' | 'failed' | 'interrupted'> {
	return status === 'interrupted' || status === 'cancelled' ? 'interrupted' : status === 'failed' ? 'failed' : 'completed';
}

function nativeSpawn(command: string, argumentsValue: readonly string[], options: SpawnOptions): CodexChild {
	return spawn(command, argumentsValue, options) as unknown as CodexChild;
}

/**
 * Supervises one Codex App Server connection. It has no direct access to a
 * model's private reasoning; only documented visible stream fields are retained.
 */
export class CodexAppServerRelay {
	private readonly spawnCodex: SpawnCodex;
	private readonly now: () => number;
	private readonly adapter: CodexAppServerAdapter;
	private readonly pending = new Map<number, PendingRequest>();
	private child: CodexChild | undefined;
	private reader: Interface | undefined;
	private requestId = 1;
	private threadId: string | undefined;
	private turnId: string | undefined;
	private timeout: ReturnType<typeof setTimeout> | undefined;
	private interruptTimeout: ReturnType<typeof setTimeout> | undefined;
	private lastUsage: TokenSnapshot | undefined;
	private terminal = false;
	private interruptRequested = false;
	private eventTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly sink: CodexRelaySink,
		private readonly options: CodexRelayOptions,
		dependencies: CodexRelayDependencies = {},
	) {
		this.spawnCodex = dependencies.spawnCodex ?? nativeSpawn;
		this.now = dependencies.now ?? Date.now;
		this.onFinished = dependencies.onFinished;
		this.adapter = new CodexAppServerAdapter({
			emitEvent: (kind, payload, correlationId) => this.sink.append({ kind, actor: 'codex-app-server', evidenceGrade: 'observed-native', payload, ...(correlationId === undefined ? {} : { correlationId }) }),
			unknown: (kind, reason, payload = {}) => this.sink.append({ kind, actor: 'codex-app-server', evidenceGrade: 'unknown', unknownReason: reason, payload }),
			reportProviderUsage: async () => undefined,
			complete: (state) => this.finish(state ?? 'completed'),
		}, { workspacePath: options.workspacePath });
	}

	private readonly onFinished: ((sessionId: string) => void) | undefined;

	async start(): Promise<void> {
		await this.sink.append({
			kind: 'adapter.lifecycle', actor: 'supervisor', evidenceGrade: 'observed-boundary',
			payload: { adapter: 'codex-app-server', phase: 'starting', maxDurationMs: this.options.maxDurationMs, ...(this.options.maxTokens === undefined ? {} : { maxTokens: this.options.maxTokens }) },
		});
		try {
			this.child = this.spawnCodex('codex', ['app-server'], {
				cwd: this.options.workspacePath,
				env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});
			this.child.once('error', (error) => {
				void this.enqueue(() => this.fail(`Codex App Server failed to start: ${error instanceof Error ? error.message : String(error)}`));
			});
			this.child.once('close', (code, signal) => {
				void this.enqueue(() => this.terminal ? Promise.resolve() : this.fail(`Codex App Server exited before the turn completed (exit ${String(code)}, signal ${String(signal)}).`));
			});
			if (this.child.stdin === null || this.child.stdout === null || this.child.stderr === null) {
				throw new Error('Codex App Server did not expose the required stdio transport.');
			}
			this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
			this.reader.on('line', (line) => {
				void this.enqueue(() => this.handleLine(line));
			});
			this.child.stderr.on('data', (data: Buffer) => {
				void this.enqueue(async () => {
					await this.sink.append({ kind: 'process.output', actor: 'boundary', evidenceGrade: 'observed-boundary', payload: { stream: 'stderr', text: data.toString('utf8'), source: 'codex-app-server' } });
				});
			});

			await this.request('initialize', { clientInfo: { name: 'model-worklog', title: 'Model Logger', version: '0.1.0' } });
			this.send({ method: 'initialized', params: {} });
			const started = asRecord(await this.request('thread/start', {
				cwd: this.options.workspacePath,
				serviceName: 'model-worklog',
				...(this.options.model === undefined ? {} : { model: this.options.model }),
			}));
			const thread = asRecord(started?.thread);
			this.threadId = stringValue(thread?.id);
			if (this.threadId === undefined) {
				throw new Error('Codex App Server did not return a thread ID.');
			}
			for (const source of Array.isArray(started?.instructionSources) ? started.instructionSources : []) {
				const path = relativePath(source, this.options.workspacePath);
				if (path !== undefined) {
					await this.sink.append({ kind: 'instruction.loaded', actor: 'codex-app-server', evidenceGrade: 'observed-native', payload: { adapter: 'codex-app-server', path } });
				}
			}
			const startedTurn = asRecord(await this.request('turn/start', {
				threadId: this.threadId,
				input: [{ type: 'text', text: this.options.task }],
				cwd: this.options.workspacePath,
				approvalPolicy: 'never',
				sandboxPolicy: {
					type: 'workspaceWrite',
					writableRoots: [this.options.workspacePath],
					networkAccess: true,
				},
			}));
			this.turnId = stringValue(asRecord(startedTurn?.turn)?.id);
			this.timeout = setTimeout(() => {
				void this.cancel('duration-limit');
			}, this.options.maxDurationMs);
			await this.sink.append({
				kind: 'adapter.lifecycle', actor: 'codex-app-server', evidenceGrade: 'observed-native',
				payload: { adapter: 'codex-app-server', phase: 'turn-started', ...(this.options.model === undefined ? {} : { model: this.options.model }) },
			});
		} catch (error) {
			await this.fail(error instanceof Error ? error.message : String(error));
			throw error;
		}
	}

	async cancel(reason = 'user-request'): Promise<void> {
		if (this.terminal || this.interruptRequested) {
			return;
		}
		this.interruptRequested = true;
		await this.sink.append({ kind: 'adapter.lifecycle', actor: 'supervisor', evidenceGrade: 'computed', payload: { adapter: 'codex-app-server', phase: 'interrupt-requested', reason } });
		if (this.threadId !== undefined && this.turnId !== undefined) {
			void this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => undefined);
		}
		this.interruptTimeout = setTimeout(() => {
			void this.finish('interrupted');
		}, INTERRUPT_GRACE_MS);
	}

	async shutdown(): Promise<void> {
		if (this.terminal) {
			return;
		}
		await this.sink.append({ kind: 'adapter.lifecycle', actor: 'supervisor', evidenceGrade: 'computed', payload: { adapter: 'codex-app-server', phase: 'interrupted-for-supervisor-shutdown' } });
		await this.finish('interrupted');
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const next = this.eventTail.then(operation, operation);
		this.eventTail = next.catch(() => undefined);
		return next;
	}

	private async handleLine(line: string): Promise<void> {
		let message: RpcResponse;
		try {
			const parsed: unknown = JSON.parse(line);
			const record = asRecord(parsed);
			if (record === undefined) {
				throw new Error('not an object');
			}
			message = record as RpcResponse;
		} catch {
			await this.sink.append({ kind: 'adapter.lifecycle', actor: 'codex-app-server', evidenceGrade: 'unknown', unknownReason: 'adapter-error', payload: { adapter: 'codex-app-server', message: 'Codex App Server emitted malformed JSON-RPC data.' } });
			return;
		}
		if (typeof message.id === 'number' && message.method === undefined) {
			const pending = this.pending.get(message.id);
			if (pending !== undefined) {
				this.pending.delete(message.id);
				clearTimeout(pending.timeout);
				if (message.error !== undefined) {
					pending.reject(new Error(stringValue(message.error.message) ?? 'Codex App Server rejected the request.'));
				} else {
					pending.resolve(message.result);
				}
			}
			return;
		}
		if (typeof message.id === 'number' && typeof message.method === 'string') {
			await this.handleServerRequest(message);
			return;
		}
		if (typeof message.method === 'string') {
			await this.handleNotification(message);
		}
	}

	private async handleNotification(message: RpcResponse): Promise<void> {
		const params = asRecord(message.params);
		if (params === undefined || message.method === undefined) {
			await this.sink.append({ kind: 'adapter.lifecycle', actor: 'codex-app-server', evidenceGrade: 'unknown', unknownReason: 'adapter-error', payload: { adapter: 'codex-app-server', message: 'Codex notification was missing object params.' } });
			return;
		}
		if (message.method === 'thread/tokenUsage/updated') {
			await this.handleUsage(params);
			return;
		}
		await this.adapter.ingestNotification({ method: message.method, params });
		if (message.method === 'turn/completed') {
			await this.finish(terminalState(asRecord(params.turn)?.status));
		}
	}

	private async handleUsage(params: Record<string, unknown>): Promise<void> {
		const normalized = normalizeOpenAIUsage({
			...params,
			usage: params.usage,
			...(this.options.model === undefined ? {} : { model: this.options.model }),
		});
		if (!normalized.ok) {
			await this.sink.append({ kind: 'usage.unavailable', actor: 'codex-app-server', evidenceGrade: 'unknown', unknownReason: normalized.reason, payload: { adapter: 'codex-app-server', message: normalized.message } });
			return;
		}
		const current = tokenSnapshot(normalized.usage);
		const delta = usageDelta(normalized.usage, this.lastUsage);
		this.lastUsage = current;
		if (delta === undefined) {
			await this.sink.append({ kind: 'usage.unavailable', actor: 'codex-app-server', evidenceGrade: 'unknown', unknownReason: 'ambiguous', payload: { adapter: 'codex-app-server', message: 'Codex reported token counters that decreased, so cumulative usage could not be safely aggregated.' } });
			return;
		}
		await this.sink.recordUsage(delta, 'observed-native');
		if (this.options.maxTokens !== undefined && current.totalTokens > this.options.maxTokens) {
			await this.sink.append({ kind: 'adapter.lifecycle', actor: 'supervisor', evidenceGrade: 'computed', payload: { adapter: 'codex-app-server', phase: 'usage-budget-exceeded', maxTokens: this.options.maxTokens, reportedTokens: current.totalTokens } });
			await this.cancel('usage-budget');
		}
	}

	private async handleServerRequest(message: RpcResponse): Promise<void> {
		const method = message.method;
		if (method === undefined || message.id === undefined) {
			return;
		}
		await this.sink.append({ kind: 'adapter.lifecycle', actor: 'codex-app-server', evidenceGrade: 'unknown', unknownReason: 'unsupported-capability', payload: { adapter: 'codex-app-server', method, message: 'This logger does not mediate App Server control requests.' } });
		this.send({ id: message.id, error: { code: -32601, message: 'Model Logger records observable activity and does not handle this App Server request.' } });
	}

	private request(method: string, params: JsonObject): Promise<unknown> {
		const id = this.requestId;
		this.requestId += 1;
		return new Promise<unknown>((resolve, reject) => {
			const timeout = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex App Server timed out responding to ${method}.`));
			}, REQUEST_TIMEOUT_MS);
			this.pending.set(id, { resolve, reject, timeout });
			try {
				this.send({ id, method, params });
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timeout);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	private send(message: JsonObject): void {
		if (this.child?.stdin === undefined || this.child.stdin === null) {
			throw new Error('Codex App Server stdin is unavailable.');
		}
		this.child.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private async fail(message: string): Promise<void> {
		if (this.terminal) {
			return;
		}
		await this.sink.append({ kind: 'adapter.lifecycle', actor: 'supervisor', evidenceGrade: 'observed-boundary', payload: { adapter: 'codex-app-server', phase: 'failed', message } });
		await this.finish('failed');
	}

	private async finish(state: Extract<SessionState, 'completed' | 'failed' | 'interrupted'>): Promise<void> {
		if (this.terminal) {
			return;
		}
		this.terminal = true;
		if (this.timeout !== undefined) {
			clearTimeout(this.timeout);
		}
		if (this.interruptTimeout !== undefined) {
			clearTimeout(this.interruptTimeout);
		}
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timeout);
			pending.reject(new Error('Codex App Server relay completed before the request returned.'));
			this.pending.delete(id);
		}
		this.reader?.close();
		this.child?.kill('SIGTERM');
		await this.sink.complete(state);
		this.onFinished?.(this.options.sessionId);
	}
}
