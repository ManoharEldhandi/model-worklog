import { isEvidenceGrade, isUnknownReason, type EvidenceGrade, type UnknownReason } from './evidence';
import { isRfc3339 } from './health';
import { describe, err, errs, isRecord, ok, type ParseIssue, type ParseResult } from './validation';

export const RUN_MODES = ['observe', 'managed'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export const SESSION_STATES = ['running', 'completed', 'failed', 'interrupted'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/**
 * Canonical event names intentionally describe observed behavior, not hidden
 * model reasoning. `agent.summary` is an optional user-visible declaration.
 */
export const EVENT_KINDS = [
	'session.started',
	'adapter.lifecycle',
	'instruction.loaded',
	'agent.message',
	'agent.summary',
	'tool.called',
	'tool.completed',
	'command.started',
	'command.completed',
	'file.read',
	'file.changed',
	'workspace.diff',
	'test.completed',
	'usage.reported',
	'usage.unavailable',
	'process.started',
	'process.output',
	'process.completed',
	'process.failed',
	'log.truncated',
	'session.completed',
	'session.interrupted',
	'session.failed',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
	readonly [key: string]: JsonValue;
}

export interface RedactionMetadata {
	readonly policyVersion: string;
	readonly replacements: number;
	readonly truncated: boolean;
}

export const TOKEN_USAGE_SOURCES = [
	'provider-reported',
	'computed-from-provider-fields',
	'adapter-reported',
] as const;

export type TokenUsageSource = (typeof TOKEN_USAGE_SOURCES)[number];
export type TokenUsageSummarySource = TokenUsageSource | 'mixed';

export function isTokenUsageSource(value: unknown): value is TokenUsageSource {
	return typeof value === 'string' && (TOKEN_USAGE_SOURCES as readonly string[]).includes(value);
}

/** Token counts from one provider response or adapter callback. */
export interface TokenUsage {
	readonly source?: TokenUsageSource;
	readonly provider?: string;
	readonly model?: string;
	readonly providerResponseId?: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cacheReadTokens?: number;
	readonly cacheWriteTokens?: number;
	readonly reasoningTokens?: number;
	readonly totalTokens?: number;
}

export type TokenUsageSummary =
	| {
		readonly status: 'reported';
		readonly source: TokenUsageSummarySource;
		readonly providers: readonly string[];
		readonly models: readonly string[];
		readonly inputTokens: number;
		readonly outputTokens: number;
		readonly cacheReadTokens: number;
		readonly cacheWriteTokens: number;
		readonly reasoningTokens: number;
		readonly totalTokens: number;
	}
	| { readonly status: 'unknown'; readonly reason: UnknownReason };

export interface WorkspaceReference {
	readonly label: string;
	readonly fingerprint: string;
}

export interface SessionRecord {
	readonly schemaVersion: number;
	readonly sessionId: string;
	/** Optional user-visible task name, supplied by an integration or derived from its first user request. */
	readonly title?: string;
	readonly runMode: RunMode;
	readonly state: SessionState;
	readonly actor: string;
	readonly workspace: WorkspaceReference;
	readonly createdAt: string;
	readonly completedAt?: string;
	readonly eventCount: number;
	readonly tokenUsage: TokenUsageSummary;
}

/**
 * A supervisor-committed log record. `sequence` and `occurredAt` are assigned
 * by the supervisor after input arrives; `sourceTimestamp` remains advisory.
 */
export interface SessionEvent {
	readonly schemaVersion: number;
	readonly eventId: string;
	readonly sessionId: string;
	readonly sequence: number;
	readonly occurredAt: string;
	readonly sourceTimestamp?: string;
	readonly kind: EventKind;
	readonly actor: string;
	readonly evidenceGrade: EvidenceGrade;
	readonly unknownReason?: UnknownReason;
	readonly correlationId?: string;
	readonly payload: JsonObject;
	readonly redaction: RedactionMetadata;
}

export function isRunMode(value: unknown): value is RunMode {
	return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value);
}

export function isSessionState(value: unknown): value is SessionState {
	return typeof value === 'string' && (SESSION_STATES as readonly string[]).includes(value);
}

export function isEventKind(value: unknown): value is EventKind {
	return typeof value === 'string' && (EVENT_KINDS as readonly string[]).includes(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return typeof value !== 'number' || Number.isFinite(value);
	}
	if (Array.isArray(value)) {
		return value.every((entry) => isJsonValue(entry));
	}
	if (!isRecord(value)) {
		return false;
	}
	return Object.values(value).every((entry) => isJsonValue(entry));
}

function requireNonEmptyString(value: unknown, path: string, issues: ParseIssue[]): string | undefined {
	if (typeof value !== 'string') {
		issues.push({ path, message: `expected string, received ${describe(value)}` });
		return undefined;
	}
	if (value.trim() === '') {
		issues.push({ path, message: 'expected non-empty string' });
		return undefined;
	}
	return value;
}

function requirePositiveInteger(value: unknown, path: string, issues: ParseIssue[]): number | undefined {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		issues.push({ path, message: `expected integer >= 1, received ${describe(value)}` });
		return undefined;
	}
	return value;
}

function parseRedaction(value: unknown, issues: ParseIssue[]): RedactionMetadata | undefined {
	if (!isRecord(value)) {
		issues.push({ path: 'redaction', message: `expected object, received ${describe(value)}` });
		return undefined;
	}

	const policyVersion = requireNonEmptyString(value.policyVersion, 'redaction.policyVersion', issues);
	const replacements = value.replacements;
	if (typeof replacements !== 'number' || !Number.isInteger(replacements) || replacements < 0) {
		issues.push({ path: 'redaction.replacements', message: `expected integer >= 0, received ${describe(replacements)}` });
	}
	const truncated = value.truncated;
	if (typeof truncated !== 'boolean') {
		issues.push({ path: 'redaction.truncated', message: `expected boolean, received ${describe(truncated)}` });
	}
	if (policyVersion === undefined || typeof replacements !== 'number' || !Number.isInteger(replacements) || replacements < 0 || typeof truncated !== 'boolean') {
		return undefined;
	}
	return { policyVersion, replacements, truncated };
}

export function parseSessionEvent(input: unknown): ParseResult<SessionEvent> {
	if (!isRecord(input)) {
		return err('', `expected object, received ${describe(input)}`);
	}

	const issues: ParseIssue[] = [];
	const schemaVersion = requirePositiveInteger(input.schemaVersion, 'schemaVersion', issues);
	const eventId = requireNonEmptyString(input.eventId, 'eventId', issues);
	const sessionId = requireNonEmptyString(input.sessionId, 'sessionId', issues);
	const sequence = requirePositiveInteger(input.sequence, 'sequence', issues);
	const occurredAt = requireNonEmptyString(input.occurredAt, 'occurredAt', issues);
	const actor = requireNonEmptyString(input.actor, 'actor', issues);
	const kind = input.kind;
	if (!isEventKind(kind)) {
		issues.push({ path: 'kind', message: `expected canonical event kind, received ${describe(kind)}` });
	}
	const evidenceGrade = input.evidenceGrade;
	if (!isEvidenceGrade(evidenceGrade)) {
		issues.push({ path: 'evidenceGrade', message: `expected evidence grade, received ${describe(evidenceGrade)}` });
	}
	const payload = input.payload;
	if (!isRecord(payload) || !isJsonValue(payload)) {
		issues.push({ path: 'payload', message: `expected JSON object, received ${describe(payload)}` });
	}
	const redaction = parseRedaction(input.redaction, issues);

	const sourceTimestamp = input.sourceTimestamp;
	if (sourceTimestamp !== undefined && typeof sourceTimestamp !== 'string') {
		issues.push({ path: 'sourceTimestamp', message: `expected string, received ${describe(sourceTimestamp)}` });
	}
	const correlationId = input.correlationId;
	if (correlationId !== undefined && typeof correlationId !== 'string') {
		issues.push({ path: 'correlationId', message: `expected string, received ${describe(correlationId)}` });
	}
	const unknownReason = input.unknownReason;
	if (evidenceGrade === 'unknown') {
		if (!isUnknownReason(unknownReason)) {
			issues.push({ path: 'unknownReason', message: `expected unknown reason, received ${describe(unknownReason)}` });
		}
	} else if (unknownReason !== undefined) {
		issues.push({ path: 'unknownReason', message: 'is only valid when evidenceGrade is unknown' });
	}
	if (occurredAt !== undefined && !isRfc3339(occurredAt)) {
		issues.push({ path: 'occurredAt', message: 'expected RFC3339 timestamp' });
	}
	if (typeof sourceTimestamp === 'string' && !isRfc3339(sourceTimestamp)) {
		issues.push({ path: 'sourceTimestamp', message: 'expected RFC3339 timestamp' });
	}

	if (issues.length > 0) {
		return errs(issues);
	}
	if (
		schemaVersion === undefined ||
		eventId === undefined ||
		sessionId === undefined ||
		sequence === undefined ||
		occurredAt === undefined ||
		actor === undefined ||
		!isEventKind(kind) ||
		!isEvidenceGrade(evidenceGrade) ||
		!isRecord(payload) ||
		!isJsonValue(payload) ||
		redaction === undefined
	) {
		return err('', 'internal: unexpected invalid session event');
	}

	return ok({
		schemaVersion,
		eventId,
		sessionId,
		sequence,
		occurredAt,
		...(typeof sourceTimestamp === 'string' ? { sourceTimestamp } : {}),
		kind,
		actor,
		evidenceGrade,
		...(evidenceGrade === 'unknown' && isUnknownReason(unknownReason) ? { unknownReason } : {}),
		...(typeof correlationId === 'string' ? { correlationId } : {}),
		payload: payload as JsonObject,
		redaction,
	});
}