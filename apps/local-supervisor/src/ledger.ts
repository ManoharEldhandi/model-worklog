import { appendFile, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

import {
	SCHEMA_VERSION,
	isTokenUsageSource,
	parseSessionEvent,
	type EventKind,
	type EvidenceGrade,
	type JsonObject,
	type RunMode,
	type SessionEvent,
	type SessionRecord,
	type SessionState,
	type TokenUsage,
	type TokenUsageSource,
	type TokenUsageSummarySource,
	type UnknownReason,
} from 'model-worklog-schema';

import { REDACTION_POLICY_VERSION, redactJson, redactText } from './redaction';

export interface CreateSessionInput {
	readonly runMode: RunMode;
	readonly actor: string;
	readonly workspacePath: string;
	readonly title?: string;
}

export interface EventDraft {
	readonly kind: EventKind;
	readonly actor: string;
	readonly evidenceGrade: EvidenceGrade;
	readonly unknownReason?: UnknownReason;
	readonly sourceTimestamp?: string;
	readonly correlationId?: string;
	readonly payload: JsonObject;
	readonly truncated?: boolean;
}

export interface UsageObservation {
	readonly actor?: string;
	readonly evidenceGrade?: Extract<EvidenceGrade, 'observed-native' | 'model-declared'>;
}

export interface EvidenceLedger {
	createSession(input: CreateSessionInput): Promise<SessionRecord>;
	append(sessionId: string, draft: EventDraft): Promise<SessionEvent>;
	complete(sessionId: string, state: Extract<SessionState, 'completed' | 'failed' | 'interrupted'>): Promise<SessionRecord>;
	recordUsage(sessionId: string, usage: TokenUsage, observation?: UsageObservation): Promise<SessionRecord>;
	recordUsageUnknown(sessionId: string, reason: UnknownReason): Promise<SessionRecord>;
	deleteSession(sessionId: string): Promise<void>;
	getSession(sessionId: string): Promise<SessionRecord | undefined>;
	listSessions(): Promise<readonly SessionRecord[]>;
	listEvents(sessionId: string): Promise<readonly SessionEvent[]>;
}

const SESSIONS_DIRECTORY = 'sessions';
const MAX_SESSION_TITLE_CHARS = 160;

export function workspaceFingerprint(workspacePath: string): string {
	return createHash('sha256').update(workspacePath).digest('hex');
}

function sessionPath(root: string, sessionId: string): string {
	return join(root, SESSIONS_DIRECTORY, `${sessionId}.json`);
}

function eventPath(root: string, sessionId: string): string {
	return join(root, SESSIONS_DIRECTORY, `${sessionId}.jsonl`);
}

function isTerminal(state: SessionState): boolean {
	return state === 'completed' || state === 'failed' || state === 'interrupted';
}

function normalizeSessionTitle(value: string | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const redacted = redactText(value).value.replace(/\s+/g, ' ').trim();
	return redacted === '' ? undefined : redacted.slice(0, MAX_SESSION_TITLE_CHARS);
}

function derivedSessionTitle(kind: EventKind, payload: JsonObject): string | undefined {
	return kind === 'agent.message' && payload.role === 'user' && typeof payload.text === 'string'
		? normalizeSessionTitle(payload.text)
		: undefined;
}

export function workspaceReference(workspacePath: string): SessionRecord['workspace'] {
	return {
		label: basename(workspacePath) || 'workspace',
		fingerprint: workspaceFingerprint(workspacePath),
	};
}

function isTokenCount(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

interface NormalizedUsage {
	readonly source: TokenUsageSource;
	readonly provider?: string;
	readonly model?: string;
	readonly providerResponseId?: string;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly reasoningTokens: number;
	readonly totalTokens: number;
}

function normalizeUsage(usage: TokenUsage): NormalizedUsage | undefined {
	const source = usage.source ?? 'adapter-reported';
	if (!isTokenUsageSource(source) || (usage.provider !== undefined && usage.provider.trim() === '') || (usage.model !== undefined && usage.model.trim() === '') || (usage.providerResponseId !== undefined && usage.providerResponseId.trim() === '')) {
		return undefined;
	}
	const inputTokens = usage.inputTokens ?? 0;
	const outputTokens = usage.outputTokens ?? 0;
	const cacheReadTokens = usage.cacheReadTokens ?? 0;
	const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
	const reasoningTokens = usage.reasoningTokens ?? 0;
	const totalTokens = usage.totalTokens;
	if (
		!isTokenCount(inputTokens) ||
		!isTokenCount(outputTokens) ||
		!isTokenCount(cacheReadTokens) ||
		!isTokenCount(cacheWriteTokens) ||
		!isTokenCount(reasoningTokens) ||
		!isTokenCount(totalTokens)
	) {
		return undefined;
	}
	return {
		source,
		...(usage.provider === undefined ? {} : { provider: usage.provider }),
		...(usage.model === undefined ? {} : { model: usage.model }),
		...(usage.providerResponseId === undefined ? {} : { providerResponseId: usage.providerResponseId }),
		inputTokens,
		outputTokens,
		cacheReadTokens,
		cacheWriteTokens,
		reasoningTokens,
		totalTokens,
	};
}

function mergeUsageSource(previous: TokenUsageSummarySource | undefined, current: TokenUsageSource): TokenUsageSummarySource {
	if (previous === undefined || previous === current) {
		return current;
	}
	return 'mixed';
}

function appendUnique(values: readonly string[], candidate: string | undefined): readonly string[] {
	return candidate === undefined || values.includes(candidate) ? values : [...values, candidate];
}

function usagePayload(usage: NormalizedUsage): JsonObject {
	return {
		source: usage.source,
		...(usage.provider === undefined ? {} : { provider: usage.provider }),
		...(usage.model === undefined ? {} : { model: usage.model }),
		...(usage.providerResponseId === undefined ? {} : { providerResponseId: usage.providerResponseId }),
		inputTokens: usage.inputTokens,
		outputTokens: usage.outputTokens,
		cacheReadTokens: usage.cacheReadTokens,
		cacheWriteTokens: usage.cacheWriteTokens,
		reasoningTokens: usage.reasoningTokens,
		totalTokens: usage.totalTokens,
	};
}

function parseStoredSession(input: unknown): SessionRecord {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new Error('stored session is not an object');
	}
	const value = input as Partial<SessionRecord>;
	if (typeof value.sessionId !== 'string' || typeof value.eventCount !== 'number' || typeof value.state !== 'string') {
		throw new Error('stored session is missing required fields');
	}
	return value as SessionRecord;
}

/**
 * A deliberately simple append-only local ledger for the first release.
 * The supervisor owns all writes, serializes sequence assignment, and redacts
 * payloads before an event reaches the filesystem.
 */
export class FileEvidenceLedger implements EvidenceLedger {
	private readonly sessions = new Map<string, SessionRecord>();
	private writeTail: Promise<void> = Promise.resolve();

	private constructor(
		private readonly root: string,
		private readonly now: () => Date,
	) {}

	static async open(root: string, now: () => Date = () => new Date()): Promise<FileEvidenceLedger> {
		await mkdir(join(root, SESSIONS_DIRECTORY), { recursive: true, mode: 0o700 });
		return new FileEvidenceLedger(root, now);
	}

	async createSession(input: CreateSessionInput): Promise<SessionRecord> {
		const createdAt = this.now().toISOString();
		const sessionId = `ses_${randomUUID()}`;
		const title = normalizeSessionTitle(input.title);
		const session: SessionRecord = {
			schemaVersion: SCHEMA_VERSION,
			sessionId,
			...(title === undefined ? {} : { title }),
			runMode: input.runMode,
			state: 'running',
			actor: input.actor,
			workspace: workspaceReference(input.workspacePath),
			createdAt,
			eventCount: 0,
			tokenUsage: { status: 'unknown', reason: 'not-observed' },
		};
		await this.enqueue(async () => {
			this.sessions.set(sessionId, session);
			await this.writeSession(session);
		});
		await this.append(sessionId, {
			kind: 'session.started',
			actor: 'supervisor',
			evidenceGrade: 'computed',
			payload: { runMode: input.runMode, actor: input.actor },
		});
		return this.requireSession(sessionId);
	}

	async append(sessionId: string, draft: EventDraft): Promise<SessionEvent> {
		let result: SessionEvent | undefined;
		await this.enqueue(async () => {
			const session = await this.requireSession(sessionId);
			if (isTerminal(session.state)) {
				throw new Error(`session ${sessionId} is already ${session.state}`);
			}
			const redactedPayload = redactJson(draft.payload);
			const event: SessionEvent = {
				schemaVersion: SCHEMA_VERSION,
				eventId: `evt_${randomUUID()}`,
				sessionId,
				sequence: session.eventCount + 1,
				occurredAt: this.now().toISOString(),
				...(draft.sourceTimestamp === undefined ? {} : { sourceTimestamp: draft.sourceTimestamp }),
				kind: draft.kind,
				actor: draft.actor,
				evidenceGrade: draft.evidenceGrade,
				...(draft.evidenceGrade === 'unknown' && draft.unknownReason !== undefined ? { unknownReason: draft.unknownReason } : {}),
				...(draft.correlationId === undefined ? {} : { correlationId: draft.correlationId }),
				payload: redactedPayload.value as JsonObject,
				redaction: {
					policyVersion: REDACTION_POLICY_VERSION,
					replacements: redactedPayload.replacements,
					truncated: draft.truncated === true,
				},
			};
			const parsed = parseSessionEvent(event);
			if (!parsed.ok) {
				throw new Error(`internal event validation failed: ${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
			}
			await appendFile(eventPath(this.root, sessionId), `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
			const title = session.title ?? derivedSessionTitle(draft.kind, redactedPayload.value as JsonObject);
			const updated: SessionRecord = { ...session, eventCount: event.sequence, ...(title === undefined ? {} : { title }) };
			this.sessions.set(sessionId, updated);
			await this.writeSession(updated);
			result = event;
		});
		if (result === undefined) {
			throw new Error('internal: event was not committed');
		}
		return result;
	}

	async complete(sessionId: string, state: Extract<SessionState, 'completed' | 'failed' | 'interrupted'>): Promise<SessionRecord> {
		const kind = state === 'completed' ? 'session.completed' : state === 'interrupted' ? 'session.interrupted' : 'session.failed';
		await this.append(sessionId, {
			kind,
			actor: 'supervisor',
			evidenceGrade: 'computed',
			payload: { state },
		});
		await this.enqueue(async () => {
			const session = await this.requireSession(sessionId);
			const updated: SessionRecord = { ...session, state, completedAt: this.now().toISOString() };
			this.sessions.set(sessionId, updated);
			await this.writeSession(updated);
		});
		return this.requireSession(sessionId);
	}

	async recordUsage(sessionId: string, usage: TokenUsage, observation: UsageObservation = {}): Promise<SessionRecord> {
		const normalized = normalizeUsage(usage);
		if (normalized === undefined) {
			throw new Error('token usage must contain non-negative integer counts and totalTokens');
		}
		await this.append(sessionId, {
			kind: 'usage.reported',
			actor: observation.actor ?? 'integration',
			evidenceGrade: observation.evidenceGrade ?? 'model-declared',
			payload: usagePayload(normalized),
		});
		await this.enqueue(async () => {
			const session = await this.requireSession(sessionId);
			const previous = session.tokenUsage.status === 'reported' ? session.tokenUsage : undefined;
			const providers = previous?.providers ?? [];
			const models = previous?.models ?? [];
			const inputTokens = previous?.inputTokens ?? 0;
			const outputTokens = previous?.outputTokens ?? 0;
			const cacheReadTokens = previous?.cacheReadTokens ?? 0;
			const cacheWriteTokens = previous?.cacheWriteTokens ?? 0;
			const reasoningTokens = previous?.reasoningTokens ?? 0;
			const totalTokens = previous?.totalTokens ?? 0;
			const updated: SessionRecord = {
				...session,
				tokenUsage: {
					status: 'reported',
					source: mergeUsageSource(previous?.source, normalized.source),
					providers: appendUnique(providers, normalized.provider),
					models: appendUnique(models, normalized.model),
					inputTokens: inputTokens + normalized.inputTokens,
					outputTokens: outputTokens + normalized.outputTokens,
					cacheReadTokens: cacheReadTokens + normalized.cacheReadTokens,
					cacheWriteTokens: cacheWriteTokens + normalized.cacheWriteTokens,
					reasoningTokens: reasoningTokens + normalized.reasoningTokens,
					totalTokens: totalTokens + normalized.totalTokens,
				},
			};
			this.sessions.set(sessionId, updated);
			await this.writeSession(updated);
		});
		return this.requireSession(sessionId);
	}

	async recordUsageUnknown(sessionId: string, reason: UnknownReason): Promise<SessionRecord> {
		await this.append(sessionId, {
			kind: 'usage.unavailable',
			actor: 'supervisor',
			evidenceGrade: 'unknown',
			unknownReason: reason,
			payload: { message: 'The active integration did not report token usage.' },
		});
		await this.enqueue(async () => {
			const session = await this.requireSession(sessionId);
			const updated: SessionRecord = {
				...session,
				tokenUsage: session.tokenUsage.status === 'reported' ? session.tokenUsage : { status: 'unknown', reason },
			};
			this.sessions.set(sessionId, updated);
			await this.writeSession(updated);
		});
		return this.requireSession(sessionId);
	}

	async deleteSession(sessionId: string): Promise<void> {
		await this.enqueue(async () => {
			const session = await this.requireSession(sessionId);
			if (!isTerminal(session.state)) {
				throw new Error(`session ${sessionId} is still running`);
			}
			await Promise.all([
				unlink(sessionPath(this.root, sessionId)),
				unlink(eventPath(this.root, sessionId)).catch((error: unknown) => {
					if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
						throw error;
					}
				}),
			]);
			this.sessions.delete(sessionId);
		});
	}

	async getSession(sessionId: string): Promise<SessionRecord | undefined> {
		const cached = this.sessions.get(sessionId);
		if (cached !== undefined) {
			return cached;
		}
		try {
			const raw = await readFile(sessionPath(this.root, sessionId), 'utf8');
			const session = parseStoredSession(JSON.parse(raw));
			this.sessions.set(sessionId, session);
			return session;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return undefined;
			}
			throw error;
		}
	}

	async listSessions(): Promise<readonly SessionRecord[]> {
		const entries = await readdir(join(this.root, SESSIONS_DIRECTORY), { withFileTypes: true });
		const sessions = await Promise.all(
			entries
				.filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
				.map(async (entry) => this.getSession(entry.name.slice(0, -'.json'.length))),
		);
		return sessions.filter((session): session is SessionRecord => session !== undefined).sort((left, right) => right.createdAt.localeCompare(left.createdAt));
	}

	async listEvents(sessionId: string): Promise<readonly SessionEvent[]> {
		if ((await this.getSession(sessionId)) === undefined) {
			return [];
		}
		try {
			const raw = await readFile(eventPath(this.root, sessionId), 'utf8');
			return raw
				.split('\n')
				.filter((line) => line !== '')
				.map((line) => {
					const parsed = parseSessionEvent(JSON.parse(line));
					if (!parsed.ok) {
						throw new Error(`stored event failed validation: ${parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
					}
					return parsed.value;
				});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return [];
			}
			throw error;
		}
	}

	private async requireSession(sessionId: string): Promise<SessionRecord> {
		const session = await this.getSession(sessionId);
		if (session === undefined) {
			throw new Error(`unknown session ${sessionId}`);
		}
		return session;
	}

	private async writeSession(session: SessionRecord): Promise<void> {
		const destination = sessionPath(this.root, session.sessionId);
		const temporary = `${destination}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(session)}\n`, { encoding: 'utf8', mode: 0o600 });
		await rename(temporary, destination);
	}

	private async enqueue(operation: () => Promise<void>): Promise<void> {
		const next = this.writeTail.then(operation, operation);
		this.writeTail = next.catch(() => undefined);
		return next;
	}
}