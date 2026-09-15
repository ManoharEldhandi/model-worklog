import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';

import {
	isEventKind,
	isEvidenceGrade,
	isJsonValue,
	isRunMode,
	isTokenUsageSource,
	isUnknownReason,
	type EventKind,
	type EvidenceGrade,
	type JsonObject,
	type JsonValue,
	type RunMode,
	type SessionRecord,
	type TokenUsage,
	type UnknownReason,
} from 'model-worklog-schema';

import { FileEvidenceLedger, workspaceReference, type EvidenceLedger } from './ledger';
import { createCodexRelay, type CodexRelayControl, type CodexRelayFactory } from './codexRelay';
import { createEvidenceBundle, verifyEvidenceBundle } from './evidenceBundle';
import { calculateCostReport } from './pricing';
import { acquireExclusiveStoreLock, createOrLoadAuthToken, readTrustedWorkspaces, tokensMatch, writeTrustedWorkspaces, type StoreLock, type TrustedWorkspace } from './state';

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_CAPTURED_OUTPUT_CHARS = 64 * 1024;
const MAX_GIT_DIFF_CHARS = 256 * 1024;
const DEFAULT_CODEX_DURATION_MS = 30 * 60 * 1_000;
const MAX_CODEX_DURATION_MS = 4 * 60 * 60 * 1_000;
const DEFAULT_CODEX_TOKEN_BUDGET = 50_000;
const MAX_CODEX_TOKEN_BUDGET = 2_000_000;

export interface ApiRequest {
	readonly method: string;
	readonly pathname: string;
	readonly query?: URLSearchParams;
	readonly authorization?: string;
	readonly body: unknown;
}

export interface ApiResult {
	readonly statusCode: number;
	readonly body: unknown;
}

export interface SupervisorServiceOptions {
	readonly dataDirectory: string;
	readonly authToken?: string;
	readonly instanceId?: string;
	readonly now?: () => Date;
	readonly ledger?: EvidenceLedger;
	readonly codexRelayFactory?: CodexRelayFactory;
}

interface CreateSessionBody {
	readonly workspacePath: string;
	readonly actor: string;
	readonly runMode: RunMode;
}

interface RunBody {
	readonly workspacePath: string;
	readonly executable: string;
	readonly args: string[];
	readonly actor: string;
}

interface CodexSessionBody {
	readonly workspacePath: string;
	readonly task: string;
	readonly model?: string;
	readonly maxDurationMs: number;
	readonly maxTokens: number;
}

interface TrustedWorkspaceResult {
	readonly workspacePath: string;
	readonly label: string;
	readonly trusted: boolean;
}

interface EventQuery {
	readonly afterSequence: number;
	readonly kinds: readonly EventKind[];
	readonly grades: readonly EvidenceGrade[];
	readonly actors: readonly string[];
	readonly path?: string;
	readonly command?: string;
}

interface GitCommandResult {
	readonly exitCode: number | null;
	readonly stdout: string;
	readonly digest: string;
	readonly truncated: boolean;
}

interface GitSnapshot {
	readonly available: boolean;
	readonly reason?: 'not-a-git-worktree' | 'git-command-failed';
	readonly paths: readonly string[];
	readonly diff: string;
	readonly diffSha256: string;
	readonly truncated: boolean;
}

function errorBody(code: string, message: string): ApiResult {
	return { statusCode: code === 'not_found' ? 404 : code === 'method_not_allowed' ? 405 : code === 'unauthorized' ? 401 : code === 'workspace_not_trusted' ? 403 : 400, body: { error: { code, message } } };
}

function ok(body: unknown, statusCode = 200): ApiResult {
	return { statusCode, body };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function requiredString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
	const value = body[key];
	return value === undefined || typeof value === 'string' ? value : undefined;
}

function optionalBoundedInteger(body: Record<string, unknown>, key: string, fallback: number, minimum: number, maximum: number): number {
	const value = body[key];
	if (value === undefined) {
		return fallback;
	}
	if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${key} must be an integer between ${minimum} and ${maximum}`);
	}
	return value;
}

function stringArray(body: Record<string, unknown>, key: string): string[] | undefined {
	const value = body[key];
	if (value === undefined) {
		return [];
	}
	return Array.isArray(value) && value.every((entry) => typeof entry === 'string') ? [...value] : undefined;
}

function queryValues(query: URLSearchParams | undefined, key: string): string[] {
	return query === undefined ? [] : query.getAll(key).flatMap((value) => value.split(',')).map((value) => value.trim()).filter((value) => value !== '');
}

function parseEventQuery(query: URLSearchParams | undefined): EventQuery {
	const afterSequenceRaw = query?.get('afterSequence');
	const afterSequence = afterSequenceRaw === null || afterSequenceRaw === undefined || afterSequenceRaw === '' ? 0 : Number(afterSequenceRaw);
	if (!Number.isInteger(afterSequence) || afterSequence < 0) {
		throw new Error('afterSequence must be a non-negative integer');
	}
	const kinds = queryValues(query, 'kind');
	if (!kinds.every(isEventKind)) {
		throw new Error('kind must contain canonical event names');
	}
	const grades = queryValues(query, 'grade');
	if (!grades.every(isEvidenceGrade)) {
		throw new Error('grade must contain evidence grades');
	}
	const actors = queryValues(query, 'actor');
	const path = query?.get('path') ?? undefined;
	const command = query?.get('command') ?? undefined;
	if ((path !== undefined && path.trim() === '') || (command !== undefined && command.trim() === '')) {
		throw new Error('path and command must not be empty when provided');
	}
	return { afterSequence, kinds, grades, actors, ...(path === undefined ? {} : { path }), ...(command === undefined ? {} : { command }) };
}

function eventMatchesQuery(event: import('model-worklog-schema').SessionEvent, query: EventQuery): boolean {
	if (event.sequence <= query.afterSequence || (query.kinds.length > 0 && !query.kinds.includes(event.kind)) || (query.grades.length > 0 && !query.grades.includes(event.evidenceGrade)) || (query.actors.length > 0 && !query.actors.includes(event.actor))) {
		return false;
	}
	const payload = event.payload as Record<string, unknown>;
	if (query.path !== undefined && (typeof payload.path !== 'string' || !payload.path.includes(query.path))) {
		return false;
	}
	if (query.command !== undefined) {
		const argumentsValue = Array.isArray(payload.args) ? payload.args.filter((value): value is string => typeof value === 'string').join(' ') : '';
		const command = [typeof payload.executable === 'string' ? payload.executable : '', argumentsValue].filter((value) => value !== '').join(' ');
		if (!command.includes(query.command)) {
			return false;
		}
	}
	return true;
}

function captureOutput(existing: string, data: Buffer): { readonly value: string; readonly truncated: boolean; readonly omittedCharacters: number } {
	const received = data.toString('utf8');
	if (existing.length >= MAX_CAPTURED_OUTPUT_CHARS) {
		return { value: existing, truncated: true, omittedCharacters: received.length };
	}
	const capacity = MAX_CAPTURED_OUTPUT_CHARS - existing.length;
	if (received.length <= capacity) {
		return { value: existing + received, truncated: false, omittedCharacters: 0 };
	}
	return { value: existing + received.slice(0, capacity), truncated: true, omittedCharacters: received.length - capacity };
}

async function runGit(workspacePath: string, args: readonly string[], maximumChars: number): Promise<GitCommandResult> {
	return new Promise((resolve) => {
		const digest = createHash('sha256');
		let stdout = '';
		let truncated = false;
		let settled = false;
		const finish = (exitCode: number | null): void => {
			if (settled) {
				return;
			}
			settled = true;
			resolve({ exitCode, stdout, digest: digest.digest('hex'), truncated });
		};
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-C', workspacePath, ...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
		} catch {
			finish(null);
			return;
		}
		const output = child.stdout;
		if (output === null) {
			finish(null);
			return;
		}
		output.on('data', (chunk: Buffer) => {
			digest.update(chunk);
			if (stdout.length >= maximumChars) {
				truncated = true;
				return;
			}
			const text = chunk.toString('utf8');
			const capacity = maximumChars - stdout.length;
			stdout += text.slice(0, capacity);
			truncated ||= text.length > capacity;
		});
		child.once('error', () => finish(null));
		child.once('close', (exitCode) => finish(exitCode));
	});
}

function changedPaths(status: string): readonly string[] {
	const paths = new Set<string>();
	for (const entry of status.split('\0')) {
		if (entry.length >= 4) {
			paths.add(entry.slice(3));
		}
	}
	return [...paths].sort();
}

async function captureGitSnapshot(workspacePath: string): Promise<GitSnapshot> {
	const workTree = await runGit(workspacePath, ['rev-parse', '--is-inside-work-tree'], 64);
	if (workTree.exitCode !== 0 || workTree.stdout.trim() !== 'true') {
		return { available: false, reason: 'not-a-git-worktree', paths: [], diff: '', diffSha256: '', truncated: false };
	}
	const [status, diff] = await Promise.all([
		runGit(workspacePath, ['status', '--porcelain=v1', '--untracked-files=all', '-z'], MAX_GIT_DIFF_CHARS),
		runGit(workspacePath, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD'], MAX_GIT_DIFF_CHARS),
	]);
	if (status.exitCode !== 0 || diff.exitCode !== 0) {
		return { available: false, reason: 'git-command-failed', paths: [], diff: '', diffSha256: '', truncated: false };
	}
	return {
		available: true,
		paths: changedPaths(status.stdout),
		diff: diff.stdout,
		diffSha256: diff.digest,
		truncated: status.truncated || diff.truncated,
	};
}

export class SupervisorService {
	readonly maxRequestBytes = MAX_REQUEST_BYTES;

	private constructor(
		private readonly dataDirectory: string,
		private readonly authToken: string,
		private readonly ledger: EvidenceLedger,
		private readonly now: () => Date,
		private readonly storeLock: StoreLock,
		private readonly codexRelayFactory: CodexRelayFactory,
	) {}

	private readonly codexRelays = new Map<string, CodexRelayControl>();

	static async open(options: SupervisorServiceOptions): Promise<SupervisorService> {
		const storeLock = await acquireExclusiveStoreLock(options.dataDirectory, options.instanceId ?? `sup_${randomUUID()}`);
		try {
			const token = await createOrLoadAuthToken(options.dataDirectory, options.authToken);
			const ledger = options.ledger ?? await FileEvidenceLedger.open(options.dataDirectory, options.now);
			const service = new SupervisorService(options.dataDirectory, token, ledger, options.now ?? (() => new Date()), storeLock, options.codexRelayFactory ?? createCodexRelay);
			await service.recoverInterruptedSessions();
			return service;
		} catch (error) {
			await storeLock.close();
			throw error;
		}
	}

	get token(): string {
		return this.authToken;
	}

	async close(): Promise<void> {
		await Promise.all([...this.codexRelays.values()].map((relay) => relay.shutdown()));
		await this.storeLock.close();
	}

	async handle(request: ApiRequest): Promise<ApiResult> {
		if (!tokensMatch(this.authToken, request.authorization)) {
			return errorBody('unauthorized', 'a valid x-model-worklog-token header is required');
		}

		try {
			if (request.method === 'GET' && request.pathname === '/v1/sessions') {
				return ok({ schemaVersion: 1, sessions: await this.ledger.listSessions() });
			}
			if (request.method === 'POST' && request.pathname === '/v1/workspaces/trust') {
				return this.trustWorkspace(request.body);
			}
			if (request.method === 'POST' && request.pathname === '/v1/workspaces/status') {
				return this.workspaceStatus(request.body);
			}
			if (request.method === 'POST' && request.pathname === '/v1/sessions') {
				return this.createSession(request.body);
			}
			if (request.method === 'POST' && request.pathname === '/v1/runs') {
				return this.startRun(request.body);
			}
			if (request.method === 'POST' && request.pathname === '/v1/codex-sessions') {
				return this.startCodexSession(request.body);
			}
			if (request.method === 'POST' && request.pathname === '/v1/evidence-bundles/verify') {
				return this.verifyEvidenceBundle(request.body);
			}

			const match = /^\/v1\/sessions\/([^/]+)(?:\/(events|usage|complete|cancel|cost|evidence-bundle))?$/.exec(request.pathname);
			if (match === null || match[1] === undefined) {
				return errorBody('not_found', `unknown path ${request.pathname}`);
			}
			const sessionId = decodeURIComponent(match[1]);
			const operation = match[2];
			if (operation === undefined && request.method === 'GET') {
				return this.getSession(sessionId);
			}
			if (operation === 'events') {
				return request.method === 'GET' ? this.getEvents(sessionId, request.query) : request.method === 'POST' ? this.appendIntegrationEvent(sessionId, request.body) : errorBody('method_not_allowed', 'events supports GET and POST');
			}
			if (operation === 'usage' && request.method === 'POST') {
				return this.recordUsage(sessionId, request.body);
			}
			if (operation === 'complete' && request.method === 'POST') {
				return this.completeSession(sessionId, request.body);
			}
			if (operation === 'cancel' && request.method === 'POST') {
				return this.cancelSession(sessionId);
			}
			if (operation === 'cost' && request.method === 'GET') {
				return this.getCost(sessionId);
			}
			if (operation === 'evidence-bundle' && request.method === 'GET') {
				return this.getEvidenceBundle(sessionId);
			}
			return errorBody('method_not_allowed', `method ${request.method} is not allowed on ${request.pathname}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return errorBody('invalid_request', message);
		}
	}

	private async trustWorkspace(body: unknown): Promise<ApiResult> {
		const workspacePath = await this.resolveWorkspacePath(body);
		const workspace = workspaceReference(workspacePath);
		const existing = await readTrustedWorkspaces(this.dataDirectory);
		const withoutCurrent = existing.filter((entry) => entry.fingerprint !== workspace.fingerprint);
		const trusted: TrustedWorkspace = { ...workspace, trustedAt: this.now().toISOString() };
		await writeTrustedWorkspaces(this.dataDirectory, [...withoutCurrent, trusted]);
		return ok({ schemaVersion: 1, workspace: trusted, trusted: true });
	}

	private async workspaceStatus(body: unknown): Promise<ApiResult> {
		const workspacePath = await this.resolveWorkspacePath(body);
		const workspace = workspaceReference(workspacePath);
		const trusted = (await readTrustedWorkspaces(this.dataDirectory)).some((entry) => entry.fingerprint === workspace.fingerprint);
		return ok({ schemaVersion: 1, workspace, trusted });
	}

	private async createSession(body: unknown): Promise<ApiResult> {
		const parsed = this.parseCreateSessionBody(body);
		const workspace = await this.resolveTrustedWorkspace(parsed.workspacePath);
		if (!workspace.trusted) {
			return errorBody('workspace_not_trusted', `workspace ${workspace.label} is not trusted`);
		}
		const session = await this.ledger.createSession({ ...parsed, workspacePath: workspace.workspacePath });
		return ok({ schemaVersion: 1, session }, 201);
	}

	private async startRun(body: unknown): Promise<ApiResult> {
		const parsed = this.parseRunBody(body);
		const workspace = await this.resolveTrustedWorkspace(parsed.workspacePath);
		if (!workspace.trusted) {
			return errorBody('workspace_not_trusted', `workspace ${workspace.label} is not trusted`);
		}
		const session = await this.ledger.createSession({ runMode: 'managed', actor: parsed.actor, workspacePath: workspace.workspacePath });
		void this.execute(session.sessionId, workspace.workspacePath, parsed).catch(() => undefined);
		return ok({ schemaVersion: 1, session }, 202);
	}

	private async startCodexSession(body: unknown): Promise<ApiResult> {
		const parsed = this.parseCodexSessionBody(body);
		const workspace = await this.resolveTrustedWorkspace(parsed.workspacePath);
		if (!workspace.trusted) {
			return errorBody('workspace_not_trusted', `workspace ${workspace.label} is not trusted`);
		}
		const session = await this.ledger.createSession({ runMode: 'managed', actor: 'codex-app-server', workspacePath: workspace.workspacePath });
		const relay = this.codexRelayFactory(
			{
				append: (draft) => this.ledger.append(session.sessionId, draft),
				recordUsage: (usage, evidenceGrade) => this.ledger.recordUsage(session.sessionId, usage, { actor: 'codex-app-server', evidenceGrade }),
				complete: (state) => this.completeWithUsageGap(session.sessionId, state),
			},
			{ ...parsed, sessionId: session.sessionId, workspacePath: workspace.workspacePath },
			(sessionId) => this.codexRelays.delete(sessionId),
		);
		this.codexRelays.set(session.sessionId, relay);
		void relay.start().catch(() => undefined);
		return ok({ schemaVersion: 1, session }, 202);
	}

	private async getSession(sessionId: string): Promise<ApiResult> {
		const session = await this.ledger.getSession(sessionId);
		return session === undefined ? errorBody('not_found', `unknown session ${sessionId}`) : ok({ schemaVersion: 1, session });
	}

	private async getEvents(sessionId: string, queryParameters?: URLSearchParams): Promise<ApiResult> {
		const session = await this.ledger.getSession(sessionId);
		if (session === undefined) {
			return errorBody('not_found', `unknown session ${sessionId}`);
		}
		const query = parseEventQuery(queryParameters);
		const allEvents = await this.ledger.listEvents(sessionId);
		const events = allEvents.filter((event) => eventMatchesQuery(event, query));
		const nextSequence = allEvents.at(-1)?.sequence ?? query.afterSequence;
		return ok({ schemaVersion: 1, sessionId, events, cursor: { afterSequence: query.afterSequence, nextSequence }, terminal: session.state !== 'running' });
	}

	private async getCost(sessionId: string): Promise<ApiResult> {
		if ((await this.ledger.getSession(sessionId)) === undefined) {
			return errorBody('not_found', `unknown session ${sessionId}`);
		}
		return ok({ sessionId, cost: calculateCostReport(await this.ledger.listEvents(sessionId)) });
	}

	private async getEvidenceBundle(sessionId: string): Promise<ApiResult> {
		const session = await this.ledger.getSession(sessionId);
		if (session === undefined) {
			return errorBody('not_found', `unknown session ${sessionId}`);
		}
		return ok({ schemaVersion: 1, bundle: createEvidenceBundle(session, await this.ledger.listEvents(sessionId), this.now().toISOString()) });
	}

	private verifyEvidenceBundle(body: unknown): ApiResult {
		const value = asRecord(body);
		if (value === undefined || value.bundle === undefined) {
			throw new Error('verify requires an evidence bundle object');
		}
		return ok({ schemaVersion: 1, verification: verifyEvidenceBundle(value.bundle) });
	}

	private async appendIntegrationEvent(sessionId: string, body: unknown): Promise<ApiResult> {
		const value = asRecord(body);
		if (value === undefined) {
			throw new Error('event body must be an object');
		}
		const kind = value.kind;
		const actor = requiredString(value, 'actor');
		const evidenceGrade = value.evidenceGrade;
		const payload = value.payload;
		if (!isEventKind(kind) || actor === undefined || !isEvidenceGrade(evidenceGrade) || !asRecord(payload) || !isJsonValue(payload)) {
			throw new Error('event requires canonical kind, non-empty actor, evidence grade, and JSON object payload');
		}
		if (evidenceGrade !== 'model-declared' && evidenceGrade !== 'unknown') {
			throw new Error('external integrations may submit only model-declared or unknown evidence');
		}
		const unknownReason = value.unknownReason;
		if (evidenceGrade === 'unknown' && !isUnknownReason(unknownReason)) {
			throw new Error('unknown evidence requires an unknownReason');
		}
		const sourceTimestamp = optionalString(value, 'sourceTimestamp');
		const correlationId = optionalString(value, 'correlationId');
		if ((value.sourceTimestamp !== undefined && sourceTimestamp === undefined) || (value.correlationId !== undefined && correlationId === undefined)) {
			throw new Error('sourceTimestamp and correlationId must be strings when provided');
		}
		const event = await this.ledger.append(sessionId, {
			kind: kind as EventKind,
			actor,
			evidenceGrade: evidenceGrade as Extract<EvidenceGrade, 'model-declared' | 'unknown'>,
			...(evidenceGrade === 'unknown' ? { unknownReason: unknownReason as UnknownReason } : {}),
			...(sourceTimestamp === undefined ? {} : { sourceTimestamp }),
			...(correlationId === undefined ? {} : { correlationId }),
			payload: payload as JsonObject,
		});
		return ok({ schemaVersion: 1, event }, 201);
	}

	private async recordUsage(sessionId: string, body: unknown): Promise<ApiResult> {
		const value = asRecord(body);
		if (value === undefined) {
			throw new Error('usage body must be an object');
		}
		const counts: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; totalTokens?: number } = {};
		for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const) {
			const count = value[key];
			if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 0)) {
				throw new Error(`${key} must be a non-negative integer when provided`);
			}
			if (typeof count === 'number') {
				counts[key] = count;
			}
		}
		const source = value.source;
		const provider = value.provider;
		const model = value.model;
		const providerResponseId = value.providerResponseId;
		if ((source !== undefined && !isTokenUsageSource(source)) || (provider !== undefined && typeof provider !== 'string') || (model !== undefined && typeof model !== 'string') || (providerResponseId !== undefined && typeof providerResponseId !== 'string')) {
			throw new Error('source must be a supported usage source; provider, model, and providerResponseId must be strings when provided');
		}
		const usage: TokenUsage = {
			...counts,
			...(source === undefined ? {} : { source }),
			...(provider === undefined ? {} : { provider }),
			...(model === undefined ? {} : { model }),
			...(providerResponseId === undefined ? {} : { providerResponseId }),
		};
		const session = await this.ledger.recordUsage(sessionId, usage);
		return ok({ schemaVersion: 1, session });
	}

	private async completeSession(sessionId: string, body: unknown): Promise<ApiResult> {
		const value = asRecord(body) ?? {};
		const state = value.state ?? 'completed';
		if (state !== 'completed' && state !== 'failed' && state !== 'interrupted') {
			throw new Error('state must be completed, failed, or interrupted');
		}
		const session = await this.completeWithUsageGap(sessionId, state);
		return ok({ schemaVersion: 1, session });
	}

	private async cancelSession(sessionId: string): Promise<ApiResult> {
		const session = await this.ledger.getSession(sessionId);
		if (session === undefined) {
			return errorBody('not_found', `unknown session ${sessionId}`);
		}
		if (session.state !== 'running') {
			return ok({ schemaVersion: 1, session });
		}
		const relay = this.codexRelays.get(sessionId);
		if (relay === undefined) {
			await this.ledger.append(sessionId, { kind: 'adapter.lifecycle', actor: 'supervisor', evidenceGrade: 'computed', payload: { phase: 'interrupted-after-relay-recovery', message: 'The supervisor no longer owns a live relay for this session.' } });
			return ok({ schemaVersion: 1, session: await this.completeWithUsageGap(sessionId, 'interrupted') });
		}
		await relay.cancel('user-request');
		return ok({ schemaVersion: 1, session: (await this.ledger.getSession(sessionId))! }, 202);
	}

	private async completeWithUsageGap(sessionId: string, state: 'completed' | 'failed' | 'interrupted'): Promise<SessionRecord> {
		const session = await this.ledger.getSession(sessionId);
		if (session === undefined) {
			throw new Error(`unknown session ${sessionId}`);
		}
		if (session.tokenUsage.status === 'unknown') {
			await this.ledger.recordUsageUnknown(sessionId, 'unsupported-capability');
		}
		return this.ledger.complete(sessionId, state);
	}

	private async recoverInterruptedSessions(): Promise<void> {
		for (const session of await this.ledger.listSessions()) {
			if (session.state !== 'running') {
				continue;
			}
			await this.ledger.append(session.sessionId, { kind: 'adapter.lifecycle', actor: 'supervisor', evidenceGrade: 'computed', payload: { phase: 'interrupted-after-supervisor-restart', message: 'The previous supervisor instance ended before this session completed.' } });
			await this.completeWithUsageGap(session.sessionId, 'interrupted');
		}
	}

	private async execute(sessionId: string, workspacePath: string, body: RunBody): Promise<void> {
		const correlationId = `cmd_${randomUUID()}`;
		const baseline = await captureGitSnapshot(workspacePath);
		await this.ledger.append(sessionId, {
			kind: 'process.started',
			actor: 'boundary',
			evidenceGrade: 'observed-boundary',
			correlationId,
			payload: { executable: body.executable, args: body.args, workspace: 'trusted-workspace' },
		});

		let stdout = '';
		let stderr = '';
		let stdoutOmitted = 0;
		let stderrOmitted = 0;
		try {
			const child = spawn(body.executable, body.args, { cwd: workspacePath, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
			child.stdout.on('data', (data: Buffer) => {
				const captured = captureOutput(stdout, data);
				stdout = captured.value;
				stdoutOmitted += captured.omittedCharacters;
			});
			child.stderr.on('data', (data: Buffer) => {
				const captured = captureOutput(stderr, data);
				stderr = captured.value;
				stderrOmitted += captured.omittedCharacters;
			});
			const result = await new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve, reject) => {
				child.once('error', reject);
				child.once('close', (code, signal) => resolve({ code, signal }));
			});
			await this.recordCapturedOutput(sessionId, 'stdout', stdout, stdoutOmitted, correlationId);
			await this.recordCapturedOutput(sessionId, 'stderr', stderr, stderrOmitted, correlationId);
			await this.recordGitDiff(sessionId, correlationId, baseline, await captureGitSnapshot(workspacePath));
			const succeeded = result.code === 0 && result.signal === null;
			await this.ledger.append(sessionId, {
				kind: 'process.completed',
				actor: 'boundary',
				evidenceGrade: 'observed-boundary',
				correlationId,
				payload: { exitCode: result.code, signal: result.signal, succeeded },
			});
			await this.completeWithUsageGap(sessionId, succeeded ? 'completed' : 'failed');
		} catch (error) {
			await this.recordGitDiff(sessionId, correlationId, baseline, await captureGitSnapshot(workspacePath));
			await this.ledger.append(sessionId, {
				kind: 'process.failed',
				actor: 'boundary',
				evidenceGrade: 'observed-boundary',
				correlationId,
				payload: { message: error instanceof Error ? error.message : String(error) },
			});
			await this.completeWithUsageGap(sessionId, 'failed');
		}
	}

	private async recordGitDiff(sessionId: string, correlationId: string, baseline: GitSnapshot, current: GitSnapshot): Promise<void> {
		if (!baseline.available || !current.available) {
			await this.ledger.append(sessionId, {
				kind: 'workspace.diff', actor: 'boundary', evidenceGrade: 'unknown', unknownReason: 'not-observed', correlationId,
				payload: { available: false, baselineReason: baseline.reason ?? 'available', currentReason: current.reason ?? 'available' },
			});
			return;
		}
		await this.ledger.append(sessionId, {
			kind: 'workspace.diff', actor: 'boundary', evidenceGrade: 'observed-boundary', correlationId,
			payload: {
				baseline: { paths: [...baseline.paths], diffSha256: baseline.diffSha256, dirty: baseline.paths.length > 0 },
				current: { paths: [...current.paths], diffSha256: current.diffSha256, truncated: current.truncated },
				changedSinceStart: baseline.diffSha256 !== current.diffSha256 || baseline.paths.join('\0') !== current.paths.join('\0'),
				diff: current.diff,
			},
			truncated: current.truncated,
		});
	}

	private async recordCapturedOutput(sessionId: string, stream: 'stdout' | 'stderr', text: string, omittedCharacters: number, correlationId: string): Promise<void> {
		if (text !== '') {
			await this.ledger.append(sessionId, {
				kind: 'process.output', actor: 'boundary', evidenceGrade: 'observed-boundary', correlationId, payload: { stream, text }, truncated: omittedCharacters > 0,
			});
		}
		if (omittedCharacters > 0) {
			await this.ledger.append(sessionId, {
				kind: 'log.truncated', actor: 'supervisor', evidenceGrade: 'computed', correlationId, payload: { stream, omittedCharacters, limit: MAX_CAPTURED_OUTPUT_CHARS },
			});
		}
	}

	private workspacePath(body: unknown): string {
		const value = asRecord(body);
		const requestedPath = value === undefined ? undefined : requiredString(value, 'workspacePath');
		if (requestedPath === undefined) {
			throw new Error('workspacePath must be a non-empty string');
		}
		return requestedPath;
	}

	private async resolveWorkspacePath(body: unknown): Promise<string> {
		return realpath(this.workspacePath(body));
	}

	private async resolveTrustedWorkspace(requestedPath: string): Promise<TrustedWorkspaceResult> {
		const workspacePath = await realpath(requestedPath);
		const workspace = workspaceReference(workspacePath);
		const trusted = (await readTrustedWorkspaces(this.dataDirectory)).some((entry) => entry.fingerprint === workspace.fingerprint);
		return { workspacePath, label: workspace.label, trusted };
	}

	private parseCreateSessionBody(body: unknown): CreateSessionBody {
		const value = asRecord(body);
		if (value === undefined) {
			throw new Error('session body must be an object');
		}
		const workspacePath = requiredString(value, 'workspacePath');
		const actor = requiredString(value, 'actor');
		const runMode = value.runMode;
		if (workspacePath === undefined || actor === undefined || !isRunMode(runMode)) {
			throw new Error('session requires workspacePath, actor, and a canonical runMode');
		}
		return { workspacePath, actor, runMode };
	}

	private parseRunBody(body: unknown): RunBody {
		const value = asRecord(body);
		if (value === undefined) {
			throw new Error('run body must be an object');
		}
		const workspacePath = requiredString(value, 'workspacePath');
		const executable = requiredString(value, 'executable');
		const args = stringArray(value, 'args');
		const actor = requiredString(value, 'actor') ?? 'managed-command';
		if (workspacePath === undefined || executable === undefined || args === undefined) {
			throw new Error('run requires workspacePath, executable, and an optional string args array');
		}
		return { workspacePath, executable, args, actor };
	}

	private parseCodexSessionBody(body: unknown): CodexSessionBody {
		const value = asRecord(body);
		if (value === undefined) {
			throw new Error('Codex session body must be an object');
		}
		const workspacePath = requiredString(value, 'workspacePath');
		const task = requiredString(value, 'task');
		const model = optionalString(value, 'model');
		if (workspacePath === undefined || task === undefined || task.length > 32_000 || (value.model !== undefined && model === undefined)) {
			throw new Error('Codex session requires workspacePath, a task up to 32000 characters, and an optional model');
		}
		const maxDurationMs = optionalBoundedInteger(value, 'maxDurationMs', DEFAULT_CODEX_DURATION_MS, 1_000, MAX_CODEX_DURATION_MS);
		const maxTokens = optionalBoundedInteger(value, 'maxTokens', DEFAULT_CODEX_TOKEN_BUDGET, 1, MAX_CODEX_TOKEN_BUDGET);
		return { workspacePath, task, ...(model === undefined ? {} : { model }), maxDurationMs, maxTokens };
	}
}