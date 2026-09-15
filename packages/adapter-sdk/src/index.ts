import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
	isJsonValue,
	type EventKind,
	type JsonObject,
	type JsonValue,
	type RunMode,
	type SessionEvent,
	type SessionRecord,
	type TokenUsage,
	type UnknownReason,
} from 'model-worklog-schema';
import { normalizeProviderUsage, type TokenUsageMapping, type UsageNormalization, type UsageProviderSelector } from './usage';

export * from './usage';
export * from './vendorAdapters';
export { formatSessionEventText, presentSessionEvent } from 'model-worklog-schema';

export const DEFAULT_SUPERVISOR_URL = 'http://127.0.0.1:43199' as const;

export interface FetchLike {
	(input: string | URL, init?: {
		readonly method?: string;
		readonly headers?: Record<string, string>;
		readonly body?: string;
		readonly signal?: AbortSignal;
	}): Promise<Response>;
}

export interface LocalSupervisorClientOptions {
	readonly supervisorUrl: string;
	readonly token: string;
	readonly fetchImpl?: FetchLike;
}

export interface StartSessionOptions {
	readonly workspacePath: string;
	readonly actor: string;
	readonly runMode?: Extract<RunMode, 'observe' | 'managed'>;
	/** Task name shown in log lists and used as the JSON download filename stem. */
	readonly title?: string;
}

export interface ToolCall {
	readonly tool: string;
	readonly arguments?: JsonObject;
	readonly correlationId?: string;
}

export interface ToolResult {
	readonly tool: string;
	readonly success: boolean;
	readonly result?: JsonValue;
	readonly error?: string;
	readonly correlationId?: string;
}

export interface ToolExecutionOptions<Result> {
	readonly serializeResult?: (result: Result) => JsonValue | undefined;
}

export interface CommandActivity {
	readonly executable: string;
	readonly args?: readonly string[];
	readonly exitCode?: number | null;
	readonly correlationId?: string;
}

export interface FileActivity {
	readonly path: string;
	readonly operation: 'created' | 'modified' | 'deleted';
	readonly correlationId?: string;
}

export interface FileReadActivity {
	readonly path: string;
	readonly tool?: string;
	readonly correlationId?: string;
}

export interface TestActivity {
	readonly name: string;
	readonly success: boolean;
	readonly durationMs?: number;
	readonly correlationId?: string;
}

export interface ProviderUsageReport {
	readonly normalized: UsageNormalization;
	readonly session?: SessionRecord;
}

export interface SessionEventSnapshot {
	readonly events: readonly SessionEvent[];
	readonly cursor: { readonly afterSequence: number; readonly nextSequence: number };
	readonly terminal: boolean;
}

export interface FollowSessionEventsOptions {
	/** First sequence to receive. Defaults to the beginning of the session. */
	readonly afterSequence?: number;
	/** Local polling interval. Defaults to 100 ms; the minimum is 25 ms. */
	readonly intervalMs?: number;
	/** Stops following without changing the session state. */
	readonly signal?: AbortSignal;
}

export type SessionEventListener = (event: SessionEvent) => void | Promise<void>;

interface ApiErrorBody {
	readonly error?: { readonly message?: string };
}

interface SessionResponse {
	readonly session: SessionRecord;
}

interface EventResponse {
	readonly event: SessionEvent;
}

export class SupervisorRequestError extends Error {
	constructor(
		readonly statusCode: number,
		message: string,
	) {
		super(message);
		this.name = 'SupervisorRequestError';
	}
}

function assertLoopbackUrl(raw: string): URL {
	const url = new URL(raw);
	const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
	if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
		throw new Error('supervisorUrl must use loopback HTTP');
	}
	return url;
}

async function localToken(environment: NodeJS.ProcessEnv): Promise<string> {
	if (environment.MODEL_WORKLOG_TOKEN !== undefined && environment.MODEL_WORKLOG_TOKEN.trim() !== '') {
		return environment.MODEL_WORKLOG_TOKEN;
	}
	const directory = environment.MODEL_WORKLOG_HOME ?? join(homedir(), '.model-worklog');
	const token = (await readFile(join(directory, 'auth-token'), 'utf8')).trim();
	if (token === '') {
		throw new Error('local supervisor credential is empty');
	}
	return token;
}

/**
 * Client for integrations running beside a local Model Worklog supervisor.
 * It cannot submit native or boundary observations; external facts are marked
 * model-declared so their provenance remains visible in reports.
 */
export class LocalSupervisorClient {
	private readonly baseUrl: URL;
	private readonly fetchImpl: FetchLike;

	constructor(private readonly options: LocalSupervisorClientOptions) {
		this.baseUrl = assertLoopbackUrl(options.supervisorUrl);
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
	}

	static async fromLocalEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<LocalSupervisorClient> {
		return new LocalSupervisorClient({
			supervisorUrl: environment.MODEL_WORKLOG_SUPERVISOR_URL ?? DEFAULT_SUPERVISOR_URL,
			token: await localToken(environment),
		});
	}

	async startSession(options: StartSessionOptions): Promise<WorklogSession> {
		const response = await this.request<SessionResponse>('/v1/sessions', 'POST', {
			workspacePath: options.workspacePath,
			actor: options.actor,
			runMode: options.runMode ?? 'observe',
			...(options.title === undefined ? {} : { title: options.title }),
		});
		return new WorklogSession(this, response.session, options.actor);
	}

	async emit(sessionId: string, actor: string, kind: EventKind, payload: JsonObject, correlationId?: string): Promise<SessionEvent> {
		const response = await this.request<EventResponse>(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, 'POST', {
			kind,
			actor,
			evidenceGrade: 'model-declared',
			payload,
			...(correlationId === undefined ? {} : { correlationId }),
		});
		return response.event;
	}

	async emitUnknown(sessionId: string, actor: string, kind: EventKind, reason: UnknownReason, payload: JsonObject = {}): Promise<SessionEvent> {
		const response = await this.request<EventResponse>(`/v1/sessions/${encodeURIComponent(sessionId)}/events`, 'POST', {
			kind,
			actor,
			evidenceGrade: 'unknown',
			unknownReason: reason,
			payload,
		});
		return response.event;
	}

	async reportUsage(sessionId: string, usage: TokenUsage): Promise<SessionRecord> {
		const response = await this.request<SessionResponse>(`/v1/sessions/${encodeURIComponent(sessionId)}/usage`, 'POST', { ...usage });
		return response.session;
	}

	async complete(sessionId: string, state: 'completed' | 'failed' | 'interrupted' = 'completed'): Promise<SessionRecord> {
		const response = await this.request<SessionResponse>(`/v1/sessions/${encodeURIComponent(sessionId)}/complete`, 'POST', { state });
		return response.session;
	}

	async getEventSnapshot(sessionId: string, afterSequence: number): Promise<SessionEventSnapshot> {
		const response = await this.request<Partial<SessionEventSnapshot>>(`/v1/sessions/${encodeURIComponent(sessionId)}/events?afterSequence=${afterSequence}`, 'GET');
		if (!Array.isArray(response.events)
			|| typeof response.cursor?.afterSequence !== 'number'
			|| typeof response.cursor.nextSequence !== 'number'
			|| typeof response.terminal !== 'boolean') {
			throw new SupervisorRequestError(200, 'Supervisor returned malformed session events.');
		}
		return {
			events: response.events as SessionEvent[],
			cursor: { afterSequence: response.cursor.afterSequence, nextSequence: response.cursor.nextSequence },
			terminal: response.terminal,
		};
	}

	private async request<T>(pathname: string, method: string, body?: JsonObject): Promise<T> {
		let response: Response;
		try {
			response = await this.fetchImpl(new URL(pathname, this.baseUrl), {
				method,
				headers: { 'content-type': 'application/json', 'x-model-worklog-token': this.options.token },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(5_000),
			});
		} catch (error) {
			throw new SupervisorRequestError(0, error instanceof Error ? error.message : String(error));
		}
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			throw new SupervisorRequestError(response.status, 'Supervisor returned invalid JSON.');
		}
		if (!response.ok) {
			const error = payload as ApiErrorBody;
			throw new SupervisorRequestError(response.status, error.error?.message ?? `Supervisor returned HTTP ${response.status}.`);
		}
		return payload as T;
	}
}

/** A session-scoped ergonomic API for an AI framework or adapter callback. */
export class WorklogSession {
	constructor(
		private readonly client: LocalSupervisorClient,
		readonly record: SessionRecord,
		private readonly actor: string,
	) {}

	message(text: string): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'agent.message', { text });
	}

	userMessage(text: string): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'agent.message', { text, role: 'user' });
	}

	agentMessage(text: string): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'agent.message', { text, role: 'assistant' });
	}

	/** Stores a user-visible model declaration, never private chain-of-thought. */
	summary(summary: string): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'agent.summary', { summary });
	}

	/** Stores a visible high-level plan, never hidden reasoning. */
	plan(summary: string, plan?: JsonValue): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'agent.summary', {
			summary,
			source: 'plan',
			...(plan === undefined ? {} : { plan }),
		});
	}

	/** Stores a provider-visible reasoning summary, never private chain-of-thought. */
	reasoningSummary(summary: string): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'agent.summary', { summary, source: 'reasoning-summary' });
	}

	toolCalled(activity: ToolCall): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'tool.called', {
			tool: activity.tool,
			...(activity.arguments === undefined ? {} : { arguments: activity.arguments }),
		}, activity.correlationId);
	}

	toolCompleted(activity: ToolResult): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'tool.completed', {
			tool: activity.tool,
			success: activity.success,
			...(activity.result === undefined ? {} : { result: activity.result }),
			...(activity.error === undefined ? {} : { error: activity.error }),
		}, activity.correlationId);
	}

	async runTool<Result>(activity: ToolCall, operation: () => Promise<Result>, options: ToolExecutionOptions<Result> = {}): Promise<Result> {
		await this.toolCalled(activity);
		let result: Result;
		try {
			result = await operation();
		} catch (error) {
			await this.toolCompleted({
				tool: activity.tool,
				success: false,
				error: error instanceof Error ? error.message : String(error),
				correlationId: activity.correlationId,
			});
			throw error;
		}
		const serialized = options.serializeResult === undefined
			? isJsonValue(result) ? result : undefined
			: options.serializeResult(result);
		await this.toolCompleted({ tool: activity.tool, success: true, ...(serialized === undefined ? {} : { result: serialized }), correlationId: activity.correlationId });
		return result;
	}

	commandStarted(activity: CommandActivity): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'command.started', {
			executable: activity.executable,
			...(activity.args === undefined ? {} : { args: [...activity.args] }),
		}, activity.correlationId);
	}

	commandCompleted(activity: CommandActivity): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'command.completed', {
			executable: activity.executable,
			...(activity.args === undefined ? {} : { args: [...activity.args] }),
			...(activity.exitCode === undefined ? {} : { exitCode: activity.exitCode }),
		}, activity.correlationId);
	}

	fileChanged(activity: FileActivity): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'file.changed', {
			path: activity.path,
			operation: activity.operation,
		}, activity.correlationId);
	}

	fileRead(activity: FileReadActivity): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'file.read', {
			path: activity.path,
			...(activity.tool === undefined ? {} : { tool: activity.tool }),
		}, activity.correlationId);
	}

	testCompleted(activity: TestActivity): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, 'test.completed', {
			name: activity.name,
			success: activity.success,
			...(activity.durationMs === undefined ? {} : { durationMs: activity.durationMs }),
		}, activity.correlationId);
	}

	reportUsage(usage: TokenUsage): Promise<SessionRecord> {
		return this.client.reportUsage(this.record.sessionId, usage);
	}

	emitEvent(kind: EventKind, payload: JsonObject, correlationId?: string): Promise<SessionEvent> {
		return this.client.emit(this.record.sessionId, this.actor, kind, payload, correlationId);
	}

	async reportProviderUsage(provider: UsageProviderSelector, response: unknown, mapping?: TokenUsageMapping): Promise<ProviderUsageReport> {
		const normalized = normalizeProviderUsage(provider, response, mapping);
		if (!normalized.ok) {
			await this.unknown('usage.unavailable', normalized.reason, { provider, message: normalized.message });
			return { normalized };
		}
		return { normalized, session: await this.reportUsage(normalized.usage) };
	}

	complete(state: 'completed' | 'failed' | 'interrupted' = 'completed'): Promise<SessionRecord> {
		return this.client.complete(this.record.sessionId, state);
	}

	unknown(kind: EventKind, reason: UnknownReason, payload: JsonObject = {}): Promise<SessionEvent> {
		return this.client.emitUnknown(this.record.sessionId, this.actor, kind, reason, payload);
	}

	/**
	 * Delivers all committed, already-redacted events for this session until it
	 * reaches a terminal state or the caller aborts. Run this in an application
	 * backend and forward events to browser clients without exposing local tokens.
	 */
	async followEvents(listener: SessionEventListener, options: FollowSessionEventsOptions = {}): Promise<void> {
		const afterSequence = options.afterSequence ?? 0;
		const intervalMs = options.intervalMs ?? 100;
		if (!Number.isInteger(afterSequence) || afterSequence < 0) {
			throw new Error('afterSequence must be a non-negative integer');
		}
		if (!Number.isInteger(intervalMs) || intervalMs < 25) {
			throw new Error('intervalMs must be an integer of at least 25');
		}
		let cursor = afterSequence;
		while (!options.signal?.aborted) {
			const snapshot = await this.client.getEventSnapshot(this.record.sessionId, cursor);
			for (const event of snapshot.events) {
				if (options.signal?.aborted) {
					return;
				}
				await listener(event);
			}
			cursor = snapshot.cursor.nextSequence;
			if (snapshot.terminal) {
				return;
			}
			await delay(intervalMs);
		}
	}
}