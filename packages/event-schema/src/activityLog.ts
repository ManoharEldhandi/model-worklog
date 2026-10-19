import { z } from 'zod';

import { buildSessionActivity, buildTraceActivity, formatActivityText, type ActivityEntry } from './activity';
import { isEvidenceGrade } from './evidence';
import type { JsonObject, JsonValue, SessionEvent, SessionState } from './events';
import { redactAttributes, redactSensitiveText } from './privacy';
import { isBoundedJson, ProjectIdSchema, TraceIdSchema, type StoredTraceSpan } from './trace';

const tokenFields = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const;
type TokenField = typeof tokenFields[number];
const tokenLabels: Record<TokenField, string> = { inputTokens: 'Input tokens', outputTokens: 'Output tokens', totalTokens: 'Total tokens', cacheReadTokens: 'Cache read tokens', cacheWriteTokens: 'Cache write tokens', reasoningTokens: 'Reasoning tokens' };

export interface LogUsage {
	readonly status: 'reported' | 'partial' | 'unknown';
	readonly requests: number;
	readonly counts: Partial<Record<TokenField, number>>;
	readonly providers: readonly string[];
	readonly models: readonly string[];
}

export interface LogOperation {
	readonly id: string;
	readonly name: string;
	readonly server?: string;
	readonly method?: string;
	readonly status: ActivityEntry['status'];
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly arguments?: JsonObject;
	readonly result?: JsonValue;
	readonly error?: string;
	readonly sourceIds: readonly string[];
}

export interface LogEntry extends ActivityEntry {
	readonly operations: readonly LogOperation[];
}

export interface ActivityLog {
	readonly schemaVersion: 1;
	readonly sessionId: string;
	readonly state: SessionState | 'unknown';
	readonly entries: readonly LogEntry[];
	readonly lines: readonly string[];
	readonly diagnostics: readonly ActivityEntry[];
	readonly usage: LogUsage;
	readonly sourceCount: number;
	readonly cursor: { readonly nextSequence: number };
	readonly summary: { readonly filesRead: number; readonly directoriesInspected: number; readonly pathsRead: number; readonly filesChanged: number; readonly toolCalls: number; readonly failedActions: number };
	readonly capture: {
		readonly underlyingExecutionComplete: false;
		readonly reasoning: 'provided' | 'not-reported' | 'withheld';
		readonly warnings: readonly string[];
	};
}

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sourceSchema = z.strictObject({
	id: z.string(), kind: z.string(), at: z.string(), evidenceGrade: z.custom<ActivityEntry['sources'][number]['evidenceGrade']>(isEvidenceGrade),
	sessionId: z.string().optional(), sequence: count.optional(), correlationId: z.string().optional(),
	stream: z.enum(['delta', 'final']).optional(), projectId: z.string().optional(), traceId: z.string().optional(),
	spanId: z.string().optional(), revision: count.optional(),
	agentId: z.string().optional(),
});
const entrySchema = z.strictObject({
	schemaVersion: z.literal(1), id: z.string(), category: z.enum(['request', 'plan', 'reasoning-summary', 'response', 'files', 'tool', 'command', 'output', 'test', 'usage', 'lifecycle', 'notice', 'agent', 'model', 'retrieval', 'embedding', 'rerank', 'memory', 'workflow', 'custom']),
	title: z.string(), startedAt: z.string(), endedAt: z.string().optional(), actor: z.string(), parentId: z.string().optional(),
	agentId: z.string().optional(),
	status: z.enum(['running', 'completed', 'failed', 'interrupted', 'unknown', 'info']), count,
	resources: z.array(z.strictObject({ path: z.string(), type: z.enum(['file', 'directory', 'path']), action: z.enum(['read', 'created', 'modified', 'deleted', 'changed']), count })),
	tools: z.array(z.strictObject({ name: z.string(), server: z.string().optional(), method: z.string().optional() })),
	details: z.array(z.strictObject({ label: z.string(), value: z.string() })), sources: z.array(sourceSchema), warnings: z.array(z.string()),
});
const logEntrySchema = entrySchema.extend({ operations: z.array(z.strictObject({
	id: z.string(), name: z.string(), server: z.string().optional(), method: z.string().optional(), status: entrySchema.shape.status, startedAt: z.string(), endedAt: z.string().optional(),
	arguments: z.custom<JsonObject>((value) => isBoundedJson(value) && value !== null && typeof value === 'object' && !Array.isArray(value)).optional(),
	result: z.custom<JsonValue>(isBoundedJson).optional(), error: z.string().optional(), sourceIds: z.array(z.string()),
})) });
const activityLogSchema = z.strictObject({
	schemaVersion: z.literal(1), sessionId: z.string(), state: z.enum(['running', 'completed', 'failed', 'interrupted', 'unknown']),
	entries: z.array(logEntrySchema), lines: z.array(z.string()), diagnostics: z.array(entrySchema),
	usage: z.strictObject({ status: z.enum(['reported', 'partial', 'unknown']), requests: count,
		counts: z.strictObject({ inputTokens: count.optional(), outputTokens: count.optional(), totalTokens: count.optional(), cacheReadTokens: count.optional(), cacheWriteTokens: count.optional(), reasoningTokens: count.optional() }),
		providers: z.array(z.string()), models: z.array(z.string()) }),
	sourceCount: count, cursor: z.strictObject({ nextSequence: count }),
	summary: z.strictObject({ filesRead: count, directoriesInspected: count, pathsRead: count, filesChanged: count, toolCalls: count, failedActions: count }),
	capture: z.strictObject({ underlyingExecutionComplete: z.literal(false), reasoning: z.enum(['provided', 'not-reported', 'withheld']), warnings: z.array(z.string()) }),
});
export const ActivityLogSchema: z.ZodType<ActivityLog> = activityLogSchema;

export interface TraceActivityLog extends Omit<ActivityLog, 'sessionId' | 'cursor'> {
	readonly projectId: string;
	readonly traceId: string;
	readonly nextCursor: string | null;
}
export const TraceActivityLogSchema: z.ZodType<TraceActivityLog> = activityLogSchema.omit({ sessionId: true, cursor: true }).extend({
	projectId: ProjectIdSchema, traceId: TraceIdSchema, nextCursor: z.string().nullable(),
});

function aggregateUsage(events: readonly SessionEvent[]): LogUsage {
	const requests = new Map<string, SessionEvent>();
	let conflicting = false;
	for (const event of events) {
		const identifier = event.payload.providerResponseId ?? event.payload.requestId;
		const key = typeof identifier === 'string' ? JSON.stringify([event.payload.provider, identifier]) : event.eventId;
		const previous = requests.get(key);
		if (previous !== undefined && tokenFields.some((field) => previous.payload[field] !== event.payload[field])) { conflicting = true; }
		requests.set(key, event);
	}
	const counts: Partial<Record<TokenField, number>> = {};
	let partial = conflicting;
	for (const field of tokenFields) {
		let total = 0;
		let supplied = 0;
		for (const event of requests.values()) {
			const value = event.payload[field];
			const reported = event.payload.reportedFields;
			if ((!Array.isArray(reported) || reported.includes(field)) && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) { total += value; supplied += 1; }
		}
		if (supplied > 0 && Number.isSafeInteger(total)) { counts[field] = total; }
		if (supplied > 0 && !Number.isSafeInteger(total)) { partial = true; }
		if (['inputTokens', 'outputTokens', 'totalTokens'].includes(field) && supplied !== requests.size) { partial = true; }
	}
	const labels = (field: 'provider' | 'model'): string[] => [...new Set([...requests.values()].flatMap((event) => typeof event.payload[field] === 'string' ? [redactSensitiveText(event.payload[field])] : []))];
	return { status: requests.size === 0 ? 'unknown' : partial ? 'partial' : 'reported', requests: requests.size, counts, providers: labels('provider'), models: labels('model') };
}

function diagnostic(event: SessionEvent): boolean {
	return (event.kind === 'adapter.lifecycle' && event.payload.userFacing !== true) || (event.kind.startsWith('session.') && event.kind !== 'session.failed')
		|| (event.kind === 'agent.summary' && event.evidenceGrade === 'unknown' && event.unknownReason === 'redacted');
}

function operationsFor(entry: ActivityEntry, byId: ReadonlyMap<string, SessionEvent>): readonly LogOperation[] {
	const operations = new Map<string, LogOperation>();
	for (const source of entry.sources) {
		const event = byId.get(source.id);
		if (event === undefined || !['tool.called', 'tool.completed', 'command.started', 'command.completed', 'process.started', 'process.completed', 'process.failed', 'file.read', 'file.changed'].includes(event.kind)) { continue; }
		const clean = redactAttributes(event.payload, { mode: 'redacted-content', maxStringLength: 16_000 }).attributes;
		const key = event.correlationId ?? event.eventId;
		const previous = operations.get(key);
		const terminal = event.kind.endsWith('.completed') || event.kind === 'process.failed';
		const state = terminal ? clean.success === true || clean.exitCode === 0 || clean.succeeded === true ? 'completed'
			: clean.success === false || (typeof clean.exitCode === 'number' && clean.exitCode !== 0) || event.kind === 'process.failed' ? 'failed' : 'unknown'
			: event.kind === 'file.read' || event.kind === 'file.changed' ? previous?.status ?? entry.status : 'running';
		const argumentsValue = clean.arguments;
		operations.set(key, {
			id: `${entry.id}/${key}`, name: typeof clean.originalTool === 'string' ? clean.originalTool : previous?.name ?? (typeof clean.tool === 'string' ? clean.tool : typeof clean.executable === 'string' ? clean.executable : entry.title),
			...(typeof clean.server === 'string' ? { server: clean.server } : previous?.server === undefined ? {} : { server: previous.server }),
			...(typeof clean.method === 'string' ? { method: clean.method } : previous?.method === undefined ? {} : { method: previous.method }),
			status: state, startedAt: previous?.startedAt ?? event.occurredAt,
			...(terminal ? { endedAt: event.occurredAt } : previous?.endedAt === undefined ? {} : { endedAt: previous.endedAt }),
			...(previous?.arguments === undefined ? {} : { arguments: previous.arguments }),
			...(argumentsValue !== null && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue) ? { arguments: argumentsValue } : {}),
			...(previous?.result === undefined ? {} : { result: previous.result }), ...(clean.result === undefined ? {} : { result: clean.result }),
			...(typeof clean.error === 'string' ? { error: clean.error } : {}), sourceIds: [...(previous?.sourceIds ?? []), event.eventId],
		});
	}
	return [...operations.values()].map((operation) => entry.status === 'unknown' && operation.status === 'running' ? { ...operation, status: 'unknown' } : operation);
}

function semanticEntry(entry: ActivityEntry, byId: ReadonlyMap<string, SessionEvent>): LogEntry {
	const operations = operationsFor(entry, byId);
	const providerError = entry.sources.some((source) => { const event = byId.get(source.id); return event?.kind === 'adapter.lifecycle' && event.payload.userFacing === true && event.payload.phase === 'failed'; });
	const streamed = entry.sources.some((source) => source.stream === 'delta') && !entry.sources.some((source) => source.stream === 'final');
	const details = entry.details.map((detail) => {
		if (detail.label !== 'Result' || operations.length !== 1) { return detail; }
		const result = operations[0]?.result;
		if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
			const content = result.detailedContent ?? result.content ?? result.text;
			if (typeof content === 'string') { return { ...detail, value: content }; }
		}
		return detail;
	});
	return { ...entry, operations, details, ...(streamed ? { status: 'running' as const, endedAt: undefined } : {}),
		...(providerError ? { category: 'notice' as const, status: 'failed' as const, title: 'Agent error' } : {}),
		...(entry.category === 'reasoning-summary' ? { title: entry.sources.some((source) => byId.get(source.id)?.payload.origin === 'provider-exposed') ? 'Reasoning (provider-exposed)' : 'Reasoning summary' } : {}),
		...(entry.category === 'files' && entry.status !== 'failed' ? { details: [] } : {}),
	};
}

function mergeStreams(entries: readonly LogEntry[]): LogEntry[] {
	const result: LogEntry[] = [];
	const streams = new Map<string, number>();
	for (const entry of entries) {
		const source = entry.sources[0];
		if (source?.correlationId === undefined || !entry.sources.every((candidate) => candidate.stream !== undefined)
			|| !['response', 'plan', 'reasoning-summary'].includes(entry.category)) { result.push(entry); continue; }
		const key = JSON.stringify([entry.actor, entry.agentId, entry.category, source.correlationId]);
		const index = streams.get(key);
		const previous = index === undefined ? undefined : result[index];
		if (previous === undefined || index === undefined) { streams.set(key, result.length); result.push(entry); continue; }
		const previousText = previous.details.find((detail) => detail.label === 'Message' || detail.label === 'Summary');
		const nextText = entry.details.find((detail) => detail.label === 'Message' || detail.label === 'Summary');
		if (previousText === undefined || nextText === undefined) { result.push(entry); continue; }
		const final = entry.sources.some((candidate) => candidate.stream === 'final');
		const finalized = previous.sources.some((candidate) => candidate.stream === 'final');
		const text = final ? nextText.value : finalized ? previousText.value : previousText.value + nextText.value;
		result[index] = { ...previous, endedAt: finalized && !final ? previous.endedAt : entry.endedAt ?? entry.startedAt, status: finalized && !final ? previous.status : entry.status, count: previous.count + entry.count,
			details: [{ label: previousText.label, value: text.slice(0, 16_000) }], sources: [...previous.sources, ...entry.sources],
			warnings: [...new Set([...previous.warnings, ...entry.warnings, ...(text.length > 16_000 ? ['Stream preview was shortened; source records retain the captured fragments.'] : [])])],
		};
	}
	return result;
}

function messageContent(event: SessionEvent): string | undefined {
	const value = event.kind === 'agent.message' ? event.payload.text : event.kind === 'agent.summary' ? event.payload.summary ?? event.payload.message : undefined;
	return typeof value === 'string' ? value : undefined;
}

function messageScope(event: SessionEvent): string {
	return JSON.stringify([event.actor, event.payload.agentId, event.kind === 'agent.message' || event.payload.source === undefined ? 'message' : event.payload.source, event.correlationId ?? event.eventId]);
}

export function buildSessionLog(input: readonly SessionEvent[], options: { readonly sessionId?: string; readonly state?: SessionState } = {}): ActivityLog {
	const events = [...new Map(input.map((event) => [event.eventId, event])).values()].sort((left, right) => left.sequence - right.sequence);
	const sessionId = options.sessionId ?? events[0]?.sessionId ?? '';
	if (events.some((event) => event.sessionId !== sessionId)) { throw new Error('A log snapshot must contain exactly one session.'); }
	const reports = events.filter((event) => event.kind === 'usage.reported');
	const usage = aggregateUsage(reports);
	const meaningfulStreams = new Set(events.filter((event) => (messageContent(event)?.trim().length ?? 0) > 0).map(messageScope));
	const isDiagnostic = (event: SessionEvent): boolean => diagnostic(event) || (messageContent(event) !== undefined && messageContent(event)?.trim() === '' && !meaningfulStreams.has(messageScope(event)));
	const diagnosticEvents = events.filter(isDiagnostic);
	const activityEvents = events.filter((event) => (!isDiagnostic(event) || event.kind.startsWith('session.')) && !event.kind.startsWith('usage.'));
	const terminal = [...events].reverse().find((event) => ['session.completed', 'session.failed', 'session.interrupted'].includes(event.kind));
	const state = options.state ?? (terminal?.kind === 'session.completed' ? 'completed' : terminal?.kind === 'session.failed' ? 'failed' : terminal?.kind === 'session.interrupted' ? 'interrupted' : events.length > 0 ? 'running' : 'unknown');
	const byId = new Map(events.map((event) => [event.eventId, event]));
	const entries = mergeStreams(buildSessionActivity(activityEvents).filter((entry) => !entry.sources.every((source) => source.kind.startsWith('session.') && source.kind !== 'session.failed'))
		.map((entry) => semanticEntry(entry, byId)));
	for (const [index, entry] of entries.entries()) {
		if (state !== 'running' && state !== 'unknown' && entry.status === 'running') {
			entries[index] = { ...entry, status: 'unknown', warnings: [...entry.warnings, 'Final stream snapshot was not captured.'] };
		}
	}
	if (state === 'completed') {
		const response = [...entries].reverse().find((entry) => entry.category === 'response' && entry.agentId === undefined);
		if (response !== undefined) { entries[entries.indexOf(response)] = { ...response, title: 'Assistant response' }; }
	}
	const usageEvents = events.filter((event) => event.kind.startsWith('usage.'));
	const latestUsage = usageEvents.at(-1);
	if (latestUsage !== undefined) {
		const sources = buildSessionActivity(usageEvents).flatMap((entry) => entry.sources);
		entries.push({ schemaVersion: 1, id: `${sessionId}/usage`, category: 'usage',
			title: usage.status === 'unknown' ? 'Token usage not reported' : `Tokens used: ${usage.counts.totalTokens?.toLocaleString('en-US') ?? 'total not reported'}`,
			startedAt: usageEvents[0]?.occurredAt ?? latestUsage.occurredAt, endedAt: latestUsage.occurredAt, actor: 'collector',
			status: 'info', count: usage.requests, resources: [], tools: [], sources,
			operations: [],
			details: [{ label: 'Requests', value: String(usage.requests) },
				...tokenFields.map((field) => ({ label: tokenLabels[field], value: usage.counts[field] === undefined ? 'not reported' : usage.counts[field].toLocaleString('en-US') })),
				{ label: 'Provider', value: usage.providers.join(', ') || 'not reported' }, { label: 'Model', value: usage.models.join(', ') || 'not reported' }],
			warnings: usage.status === 'partial' ? ['Usage is partial; some request counters were not reported.'] : [],
		});
	}
	const diagnostics = buildSessionActivity(diagnosticEvents);
	const resources = entries.filter((entry) => entry.status === 'completed').flatMap((entry) => entry.resources);
	const distinct = (predicate: (resource: ActivityEntry['resources'][number]) => boolean): number => new Set(resources.filter(predicate).map((resource) => resource.path)).size;
	return { schemaVersion: 1, sessionId, state, entries, lines: entries.flatMap(formatActivityText), diagnostics, usage,
		sourceCount: events.length, cursor: { nextSequence: events.at(-1)?.sequence ?? 0 },
		summary: { filesRead: distinct((resource) => resource.action === 'read' && resource.type === 'file'),
			directoriesInspected: distinct((resource) => resource.action === 'read' && resource.type === 'directory'),
			pathsRead: distinct((resource) => resource.action === 'read' && resource.type === 'path'), filesChanged: distinct((resource) => resource.action !== 'read'),
			toolCalls: entries.flatMap((entry) => entry.operations).length, failedActions: entries.filter((entry) => entry.status === 'failed').length },
		capture: { underlyingExecutionComplete: false,
			reasoning: entries.some((entry) => entry.category === 'reasoning-summary') ? 'provided'
				: diagnosticEvents.some((event) => event.kind === 'agent.summary' && event.unknownReason === 'redacted') ? 'withheld' : 'not-reported',
			warnings: [...new Set([...entries, ...diagnostics].flatMap((entry) => entry.warnings))],
		},
	};
}

export function buildTraceLog(input: readonly StoredTraceSpan[], options: { readonly projectId: string; readonly traceId: string; readonly nextCursor?: string | null }): TraceActivityLog {
	const latest = new Map<string, StoredTraceSpan>();
	for (const stored of input) {
		if (stored.span.projectId !== options.projectId || stored.span.traceId !== options.traceId) { throw new Error('Trace log contains a span outside its authorized scope.'); }
		if ((latest.get(stored.span.spanId)?.span.revision ?? 0) < stored.span.revision) { latest.set(stored.span.spanId, stored); }
	}
	const spans = [...latest.values()];
	const entries: LogEntry[] = buildTraceActivity(spans).map((entry) => ({ ...entry,
		operations: entry.sources.flatMap((source): LogOperation[] => {
			const stored = source.spanId === undefined ? undefined : latest.get(source.spanId);
			if (stored === undefined) { return []; }
			const clean = redactAttributes(stored.span.attributes, { mode: 'redacted-content', maxStringLength: 16_000 }).attributes;
			const argumentsValue = clean.input;
			return [{ id: `${options.projectId}/${options.traceId}/${stored.span.spanId}`, name: stored.span.name, status: stored.span.state,
				...(typeof clean['mcp.server.name'] === 'string' ? { server: clean['mcp.server.name'] } : {}),
				...(typeof clean['mcp.method'] === 'string' ? { method: clean['mcp.method'] } : {}),
				startedAt: stored.span.startedAt, ...(stored.span.endedAt === undefined ? {} : { endedAt: stored.span.endedAt }),
				...(argumentsValue !== null && typeof argumentsValue === 'object' && !Array.isArray(argumentsValue) ? { arguments: argumentsValue } : {}),
				...(clean.output === undefined ? {} : { result: clean.output }), sourceIds: [source.id] }];
		}),
	}));
	const modelSpans = spans.filter(({ span }) => span.kind === 'model' && span.state !== 'running');
	for (const stored of spans) {
		for (const [index, event] of stored.span.events.entries()) {
			if (event.name !== 'agent.reasoning.summary' || event.attributes.visibility !== 'provider-exposed' || typeof event.attributes.summary !== 'string') { continue; }
			const clean = redactAttributes({ summary: event.attributes.summary }, { mode: 'redacted-content', maxStringLength: 16_000 });
			const summary = clean.attributes.summary;
			if (typeof summary !== 'string') { continue; }
			entries.push({ schemaVersion: 1, id: `${options.projectId}/${options.traceId}/${stored.span.spanId}/reasoning/${index}`, category: 'reasoning-summary',
				title: 'Reasoning (provider-exposed)', startedAt: event.at, actor: redactSensitiveText(stored.span.serviceName), status: 'info', count: 1,
				parentId: `${options.projectId}/${options.traceId}/${stored.span.spanId}`, resources: [], tools: [], operations: [],
				details: [{ label: 'Summary', value: summary }], sources: [{ id: `${stored.span.traceId}/${stored.span.spanId}@${stored.span.revision}#event:${index}`, kind: event.name, at: event.at,
					evidenceGrade: stored.evidenceGrade, projectId: options.projectId, traceId: options.traceId, spanId: stored.span.spanId, revision: stored.span.revision }],
				warnings: clean.report.truncatedFields > 0 ? ['Reasoning preview was shortened.'] : [],
			});
		}
	}
	entries.sort((left, right) => left.startedAt.localeCompare(right.startedAt));
	const reports: SessionEvent[] = modelSpans.filter(({ span }) => span.usage !== undefined).map(({ span, receivedAt, sequence }) => ({
		schemaVersion: 1, eventId: span.spanId, sessionId: span.traceId, sequence, occurredAt: receivedAt, actor: span.serviceName,
		kind: 'usage.reported', evidenceGrade: 'model-declared', payload: JSON.parse(JSON.stringify(span.usage)) as JsonObject,
		redaction: { policyVersion: '1', replacements: 0, truncated: false },
	}));
	const nextCursor = options.nextCursor ?? null;
	let usage = aggregateUsage(reports);
	if (nextCursor !== null || modelSpans.some(({ span }) => span.usage === undefined)) { usage = { ...usage, status: usage.requests === 0 ? 'unknown' : 'partial' }; }
	const usageSources = modelSpans.flatMap(({ span }) => entries.flatMap((entry) => entry.sources.filter((source) => source.spanId === span.spanId)));
	if (usageSources.length > 0) {
		entries.push({ schemaVersion: 1, id: `${options.projectId}/${options.traceId}/usage`, category: 'usage', title: `Tokens used: ${usage.counts.totalTokens ?? 'not reported'}`,
			startedAt: modelSpans[0]?.span.startedAt ?? '', actor: 'collector', status: 'info', count: usage.requests, resources: [], tools: [], operations: [], sources: usageSources,
			details: tokenFields.map((field) => ({ label: tokenLabels[field], value: usage.counts[field] === undefined ? 'not reported' : usage.counts[field].toLocaleString('en-US') })),
			warnings: usage.status === 'partial' ? ['Usage is partial for the loaded capture.'] : [],
		});
	}
	const resources = entries.filter((entry) => entry.status === 'completed').flatMap((entry) => entry.resources);
	const distinct = (type: 'file' | 'directory' | 'path'): number => new Set(resources.filter((resource) => resource.action === 'read' && resource.type === type).map((resource) => resource.path)).size;
	return { schemaVersion: 1, projectId: options.projectId, traceId: options.traceId, nextCursor,
		state: spans.length === 0 ? 'unknown' : spans.some(({ span }) => span.state === 'running') ? 'running' : spans.some(({ span }) => span.state === 'failed') ? 'failed' : spans.some(({ span }) => span.state === 'interrupted') ? 'interrupted' : 'completed',
		entries, lines: entries.flatMap(formatActivityText), diagnostics: [], usage, sourceCount: spans.length,
		summary: { filesRead: distinct('file'), directoriesInspected: distinct('directory'), pathsRead: distinct('path'),
			filesChanged: new Set(resources.filter((resource) => resource.action !== 'read').map((resource) => resource.path)).size,
			toolCalls: entries.filter((entry) => entry.category === 'tool' || entry.category === 'files').flatMap((entry) => entry.operations).length,
			failedActions: entries.filter((entry) => entry.status === 'failed').length },
		capture: { underlyingExecutionComplete: false, reasoning: entries.some((entry) => entry.category === 'reasoning-summary') ? 'provided' : 'not-reported', warnings: [...new Set([
			...entries.flatMap((entry) => entry.warnings), ...(nextCursor === null ? [] : ['More retained spans are available; this log page and usage summary are partial.']),
		])] },
	};
}
