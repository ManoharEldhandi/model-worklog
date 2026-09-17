import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';

import { CopilotCliAdapter } from 'model-worklog-sdk';
import type { JsonObject, SessionState, TokenUsage } from 'model-worklog-schema';

import type { EventDraft } from './ledger';

const INTERRUPT_GRACE_MS = 3_000;

export interface CopilotRelayOptions {
	readonly sessionId: string;
	readonly workspacePath: string;
	readonly task: string;
	readonly model?: string;
	readonly maxDurationMs: number;
}

export interface CopilotRelaySink {
	append(draft: EventDraft): Promise<unknown>;
	recordUsage(usage: TokenUsage, evidenceGrade: 'observed-native'): Promise<unknown>;
	complete(state: Extract<SessionState, 'completed' | 'failed' | 'interrupted'>): Promise<unknown>;
}

export interface CopilotChild {
	readonly stdout: NodeJS.ReadableStream | null;
	readonly stderr: NodeJS.ReadableStream | null;
	kill(signal?: NodeJS.Signals): boolean;
	once(event: 'error' | 'close', listener: (...argumentsValue: unknown[]) => void): unknown;
}

export type SpawnCopilot = (command: string, argumentsValue: readonly string[], options: SpawnOptions) => CopilotChild;

export interface CopilotRelayDependencies {
	readonly spawnCopilot?: SpawnCopilot;
	readonly onFinished?: (sessionId: string) => void;
}

export interface CopilotRelayControl {
	start(): Promise<void>;
	cancel(reason?: string): Promise<void>;
	shutdown(): Promise<void>;
}

export type CopilotRelayFactory = (
	sink: CopilotRelaySink,
	options: CopilotRelayOptions,
	onFinished: (sessionId: string) => void,
) => CopilotRelayControl;

interface TelemetrySpan {
	readonly type?: unknown;
	readonly name?: unknown;
	readonly attributes?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringValue(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function terminalState(exitCode: unknown, interrupted: boolean): Extract<SessionState, 'completed' | 'failed' | 'interrupted'> {
	if (interrupted) {
		return 'interrupted';
	}
	return exitCode === 0 ? 'completed' : 'failed';
}

function nativeSpawn(command: string, argumentsValue: readonly string[], options: SpawnOptions): CopilotChild {
	return spawn(command, argumentsValue, options) as unknown as CopilotChild;
}

export function copilotTelemetryUsage(content: string, fallbackModel?: string): readonly TokenUsage[] {
	const usage: TokenUsage[] = [];
	for (const line of content.split('\n')) {
		if (line.trim() === '') {
			continue;
		}
		try {
			const span = JSON.parse(line) as TelemetrySpan;
			if (span.type !== 'span' || typeof span.name !== 'string' || !span.name.startsWith('chat ')) {
				continue;
			}
			const attributes = asRecord(span.attributes);
			if (attributes === undefined) {
				continue;
			}
			const inputTokens = count(attributes['gen_ai.usage.input_tokens']);
			const outputTokens = count(attributes['gen_ai.usage.output_tokens']);
			if (inputTokens === undefined && outputTokens === undefined) {
				continue;
			}
			const cacheReadTokens = count(attributes['gen_ai.usage.cache_read.input_tokens']);
			const reasoningTokens = count(attributes['gen_ai.usage.reasoning.output_tokens']);
			const model = stringValue(attributes['gen_ai.response.model']) ?? stringValue(attributes['gen_ai.request.model']) ?? fallbackModel;
			usage.push({
				source: 'provider-reported',
				provider: stringValue(attributes['gen_ai.provider.name']) ?? 'github-copilot',
				...(model === undefined ? {} : { model }),
				inputTokens,
				outputTokens,
				cacheReadTokens,
				reasoningTokens,
				totalTokens: (inputTokens ?? 0) + (outputTokens ?? 0),
			});
		} catch {
			continue;
		}
	}
	return usage;
}

/**
 * Supervises one Copilot CLI task using its documented JSONL and OpenTelemetry
 * exports. The relay retains visible events but never raw model reasoning.
 */
export class CopilotCliRelay implements CopilotRelayControl {
	private readonly spawnCopilot: SpawnCopilot;
	private readonly adapter: CopilotCliAdapter;
	private readonly onFinished: ((sessionId: string) => void) | undefined;
	private child: CopilotChild | undefined;
	private reader: Interface | undefined;
	private telemetryDirectory: string | undefined;
	private timeout: ReturnType<typeof setTimeout> | undefined;
	private interruptTimeout: ReturnType<typeof setTimeout> | undefined;
	private terminal = false;
	private interruptRequested = false;
	private eventTail: Promise<void> = Promise.resolve();

	constructor(
		private readonly sink: CopilotRelaySink,
		private readonly options: CopilotRelayOptions,
		dependencies: CopilotRelayDependencies = {},
	) {
		this.spawnCopilot = dependencies.spawnCopilot ?? nativeSpawn;
		this.onFinished = dependencies.onFinished;
		this.adapter = new CopilotCliAdapter({
			emitEvent: (kind, payload, correlationId) => this.sink.append({ kind, actor: 'copilot-cli', evidenceGrade: 'observed-native', payload, ...(correlationId === undefined ? {} : { correlationId }) }),
			unknown: (kind, reason, payload = {}) => this.sink.append({ kind, actor: 'copilot-cli', evidenceGrade: 'unknown', unknownReason: reason, payload }),
			reportProviderUsage: async () => undefined,
			complete: async () => undefined,
		}, { workspacePath: options.workspacePath });
	}

	async start(): Promise<void> {
		await this.sink.append({
			kind: 'adapter.lifecycle', actor: 'supervisor', evidenceGrade: 'observed-boundary',
			payload: { adapter: 'copilot-cli', phase: 'starting', maxDurationMs: this.options.maxDurationMs },
		});
		try {
			this.telemetryDirectory = await mkdtemp(join(tmpdir(), 'model-worklog-copilot-otel-'));
			const telemetryPath = join(this.telemetryDirectory, 'telemetry.jsonl');
			this.child = this.spawnCopilot('copilot', [
				'--prompt', this.options.task,
				'--output-format', 'json',
				'--stream', 'on',
				'--allow-all-tools',
				'--no-color',
				...(this.options.model === undefined ? [] : ['--model', this.options.model]),
			], {
				cwd: this.options.workspacePath,
				env: {
					...process.env,
					COPILOT_OTEL_FILE_EXPORTER_PATH: telemetryPath,
					COPILOT_OTEL_EXPORTER_TYPE: 'file',
					OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
				},
				stdio: ['ignore', 'pipe', 'pipe'],
				windowsHide: true,
			});
			this.child.once('error', (error) => {
				void this.enqueue(() => this.fail(`Copilot CLI failed to start: ${error instanceof Error ? error.message : String(error)}`));
			});
			this.child.once('close', (code) => {
				void this.enqueue(() => this.finish(terminalState(code, this.interruptRequested)));
			});
			if (this.child.stdout === null || this.child.stderr === null) {
				throw new Error('Copilot CLI did not expose the required output streams.');
			}
			this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
			this.reader.on('line', (line) => {
				void this.enqueue(() => this.handleLine(line));
			});
			this.child.stderr.on('data', (data: Buffer) => {
				void this.enqueue(async () => {
					await this.sink.append({
						kind: 'process.output', actor: 'boundary', evidenceGrade: 'observed-boundary',
						payload: { stream: 'stderr', text: data.toString('utf8'), source: 'copilot-cli' },
					});
				});
			});
			this.timeout = setTimeout(() => {
				void this.cancel('duration-limit');
			}, this.options.maxDurationMs);
			await this.sink.append({
				kind: 'adapter.lifecycle', actor: 'copilot-cli', evidenceGrade: 'observed-native',
				payload: { adapter: 'copilot-cli', phase: 'started', ...(this.options.model === undefined ? {} : { model: this.options.model }) },
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
		await this.sink.append({
			kind: 'adapter.lifecycle', actor: 'supervisor', evidenceGrade: 'computed',
			payload: { adapter: 'copilot-cli', phase: 'interrupt-requested', reason },
		});
		this.child?.kill('SIGTERM');
		this.interruptTimeout = setTimeout(() => {
			this.child?.kill('SIGKILL');
		}, INTERRUPT_GRACE_MS);
	}

	shutdown(): Promise<void> {
		return this.cancel('supervisor-shutdown');
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const next = this.eventTail.then(operation, operation);
		this.eventTail = next.catch(() => undefined);
		return next;
	}

	private async handleLine(line: string): Promise<void> {
		try {
			await this.adapter.ingestEvent(JSON.parse(line) as unknown);
		} catch {
			await this.sink.append({
				kind: 'adapter.lifecycle', actor: 'copilot-cli', evidenceGrade: 'unknown', unknownReason: 'adapter-error',
				payload: { adapter: 'copilot-cli', message: 'Copilot CLI emitted malformed JSON event data.' },
			});
		}
	}

	private async recordUsage(): Promise<void> {
		if (this.telemetryDirectory === undefined) {
			return;
		}
		let content: string;
		try {
			content = await readFile(join(this.telemetryDirectory, 'telemetry.jsonl'), 'utf8');
		} catch {
			return;
		}
		for (const usage of copilotTelemetryUsage(content, this.options.model)) {
			await this.sink.recordUsage(usage, 'observed-native');
		}
	}

	private async fail(message: string): Promise<void> {
		if (this.terminal) {
			return;
		}
		await this.sink.append({
			kind: 'adapter.lifecycle', actor: 'supervisor', evidenceGrade: 'observed-boundary',
			payload: { adapter: 'copilot-cli', phase: 'failed', message },
		});
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
		this.reader?.close();
		await this.recordUsage();
		await this.sink.complete(state);
		if (this.telemetryDirectory !== undefined) {
			await rm(this.telemetryDirectory, { recursive: true, force: true });
		}
		this.onFinished?.(this.options.sessionId);
	}
}

export const createCopilotRelay: CopilotRelayFactory = (sink, options, onFinished) => new CopilotCliRelay(sink, options, { onFinished });