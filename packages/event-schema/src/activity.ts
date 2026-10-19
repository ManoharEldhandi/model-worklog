import type { EvidenceGrade } from './evidence';
import type { JsonObject, JsonValue, SessionEvent } from './events';
import { presentSessionEvent, type TimelineDetail } from './presentation';
import { redactAttributes, redactSensitiveText } from './privacy';
import type { StoredTraceSpan } from './trace';

export type ActivityCategory = 'request' | 'plan' | 'reasoning-summary' | 'response' | 'files' | 'tool' | 'command' | 'output' | 'test' | 'usage' | 'lifecycle' | 'notice' | 'agent' | 'model' | 'retrieval' | 'embedding' | 'rerank' | 'memory' | 'workflow' | 'custom';
export type ActivityStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'unknown' | 'info';

export interface ActivitySource {
	readonly id: string;
	readonly kind: string;
	readonly at: string;
	readonly evidenceGrade: EvidenceGrade;
	readonly sessionId?: string;
	readonly sequence?: number;
	readonly correlationId?: string;
	readonly stream?: 'delta' | 'final';
	readonly projectId?: string;
	readonly traceId?: string;
	readonly spanId?: string;
	readonly revision?: number;
	readonly agentId?: string;
}

export interface ActivityTool {
	readonly name: string;
	readonly server?: string;
	readonly method?: string;
}

export interface ActivityResource {
	readonly path: string;
	readonly type: 'file' | 'directory' | 'path';
	readonly action: 'read' | 'created' | 'modified' | 'deleted' | 'changed';
	readonly count: number;
}

export interface ActivityEntry {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly category: ActivityCategory;
	readonly title: string;
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly actor: string;
	readonly parentId?: string;
	readonly agentId?: string;
	readonly status: ActivityStatus;
	readonly count: number;
	readonly resources: readonly ActivityResource[];
	readonly tools: readonly ActivityTool[];
	readonly details: readonly TimelineDetail[];
	readonly sources: readonly ActivitySource[];
	readonly warnings: readonly string[];
}

function category(event: SessionEvent): ActivityCategory {
	switch (event.kind) {
		case 'agent.message': return event.payload.role === 'user' ? 'request' : 'response';
		case 'agent.summary': return event.payload.source === 'plan' ? 'plan' : event.payload.source === 'reasoning-summary' ? 'reasoning-summary' : 'response';
		case 'file.read': case 'file.changed': return 'files';
		case 'tool.called': case 'tool.completed': return 'tool';
		case 'command.started': case 'command.completed': case 'process.started': case 'process.completed': case 'process.failed': return 'command';
		case 'process.output': return 'output';
		case 'test.completed': return 'test';
		case 'usage.reported': case 'usage.unavailable': return 'usage';
		case 'session.started': case 'session.completed': case 'session.failed': case 'session.interrupted': case 'adapter.lifecycle': return 'lifecycle';
		default: return 'notice';
	}
}

function eventStatus(event: SessionEvent): ActivityStatus {
	if (event.evidenceGrade === 'unknown' || event.kind === 'usage.unavailable') { return 'unknown'; }
	switch (event.kind) {
		case 'agent.message': case 'agent.summary': return event.payload.final === true ? 'completed' : 'info';
		case 'tool.called': case 'command.started': case 'process.started': return 'running';
		case 'tool.completed': case 'test.completed': return event.payload.success === true ? 'completed' : event.payload.success === false ? 'failed' : 'unknown';
		case 'command.completed': case 'process.completed': return event.payload.cancelled === true ? 'interrupted' : event.payload.exitCode === 0 || event.payload.succeeded === true ? 'completed' : typeof event.payload.exitCode === 'number' || event.payload.succeeded === false ? 'failed' : 'unknown';
		case 'process.failed': case 'session.failed': return 'failed';
		case 'session.interrupted': return 'interrupted';
		case 'session.completed': case 'file.read': case 'file.changed': return 'completed';
		default: return 'info';
	}
}

function resourceTitle(resources: readonly ActivityResource[]): string {
	const directories = resources.filter((resource) => resource.type === 'directory').length;
	const files = resources.length - directories;
	const parts: string[] = [];
	if (files > 0) { parts.push(`Read ${files} ${files === 1 ? 'file' : 'files'}`); }
	if (directories > 0) { parts.push(`${files === 0 ? 'Inspected' : 'inspected'} ${directories} ${directories === 1 ? 'directory' : 'directories'}`); }
	return parts.join(' and ');
}

function sessionEntry(event: SessionEvent): ActivityEntry {
	const clean = redactAttributes(event.payload, { mode: 'redacted-content', maxStringLength: 16_000 });
	const payload = clean.attributes;
	const presentation = presentSessionEvent({ ...event, payload });
	const action = payload.operation === 'created' || payload.operation === 'modified' || payload.operation === 'deleted' ? payload.operation : 'changed';
	const resources: ActivityResource[] = (event.kind === 'file.read' || event.kind === 'file.changed') && typeof payload.path === 'string'
		? [{ path: payload.path, type: payload.pathType === 'directory' ? 'directory' : payload.pathType === 'file' ? 'file' : 'path', action: event.kind === 'file.read' ? 'read' : action, count: 1 }]
		: [];
	return {
		schemaVersion: 1, id: `${event.sessionId}/${event.eventId}`, category: category(event),
		title: event.kind === 'file.read' && resources.length > 0 ? resourceTitle(resources) : redactSensitiveText(presentation.title),
		startedAt: event.occurredAt, actor: redactSensitiveText(event.actor), status: eventStatus(event), count: 1, resources,
		...(typeof payload.agentId === 'string' ? { agentId: payload.agentId } : {}),
		tools: typeof payload.tool !== 'string' ? [] : [{ name: payload.tool,
			...(typeof payload.server === 'string' ? { server: payload.server } : {}),
			...(typeof payload.method === 'string' ? { method: payload.method } : {}) }],
		details: presentation.details.filter((entry) => resources.length === 0 || entry.label !== 'Tool').map((entry) => ({ label: entry.label, value: redactSensitiveText(entry.value) })),
		sources: [{ id: event.eventId, kind: event.kind, at: event.occurredAt, evidenceGrade: event.evidenceGrade,
			sessionId: event.sessionId, sequence: event.sequence, ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
			...(event.payload.delta === true ? { stream: 'delta' as const } : event.payload.final === true ? { stream: 'final' as const } : {}) }],
		warnings: [
			...(event.unknownReason === undefined ? [] : [`Capture unavailable: ${event.unknownReason}.`]),
			...(event.redaction.replacements === 0 ? [] : [`${event.redaction.replacements} sensitive value(s) redacted.`]),
			...(event.redaction.truncated ? ['Source output was truncated.'] : []),
			...(clean.report.truncatedFields === 0 ? [] : ['Activity details were shortened; source records retain the captured evidence.']),
		],
	};
}

function mergeReads(previous: ActivityEntry, next: ActivityEntry): ActivityEntry {
	const resources = [...previous.resources];
	for (const resource of next.resources) {
		const index = resources.findIndex((candidate) => candidate.path === resource.path && candidate.type === resource.type);
		const existing = resources[index];
		if (existing === undefined) { resources.push(resource); }
		else { resources[index] = { ...existing, count: existing.count + resource.count }; }
	}
	const endedAt = [previous.endedAt ?? previous.startedAt, next.endedAt ?? next.startedAt].sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1);
	return { ...previous, title: resourceTitle(resources), endedAt,
		status: previous.status === 'running' || next.status === 'running' ? 'running' : 'completed',
		count: previous.count + next.count, resources,
		tools: [...new Map([...previous.tools, ...next.tools].map((tool) => [JSON.stringify(tool), tool])).values()],
		details: [...previous.details, ...next.details], sources: [...previous.sources, ...next.sources],
		warnings: [...new Set([...previous.warnings, ...next.warnings])] };
}

function sameScope(previous: ActivityEntry, next: ActivityEntry): boolean {
	return previous.actor === next.actor && previous.sources[0]?.sessionId === next.sources[0]?.sessionId
		&& previous.agentId === next.agentId
		&& previous.sources[0]?.traceId === next.sources[0]?.traceId && previous.sources[0]?.projectId === next.sources[0]?.projectId
		&& previous.parentId === next.parentId
		&& previous.sources[0]?.evidenceGrade === next.sources[0]?.evidenceGrade;
}

function mergeTextStream(previous: ActivityEntry, next: ActivityEntry): ActivityEntry | undefined {
	if (!sameScope(previous, next) || previous.category !== next.category
		|| !['response', 'plan', 'reasoning-summary'].includes(previous.category)
		|| previous.sources[0]?.correlationId === undefined || previous.sources[0]?.correlationId !== next.sources[0]?.correlationId
		|| !previous.sources.every((source) => source.stream === 'delta') || next.sources[0]?.stream === undefined
		|| previous.status === 'unknown' || next.status === 'unknown') { return undefined; }
	const previousText = previous.details.find((detail) => detail.label === 'Message' || detail.label === 'Summary');
	const nextText = next.details.find((detail) => detail.label === 'Message' || detail.label === 'Summary');
	if (previousText === undefined || nextText === undefined) { return undefined; }
	const final = next.sources[0]?.stream === 'final';
	const combined = final ? nextText.value : previousText.value + nextText.value;
	return { ...previous, title: final && previous.category === 'response' ? 'Assistant response' : previous.title,
		endedAt: next.endedAt ?? next.startedAt, status: next.status, count: previous.count + next.count,
		details: [{ label: previousText.label, value: combined.slice(0, 16_000) },
			...previous.details.filter((detail) => detail !== previousText), ...next.details.filter((detail) => detail !== nextText)],
		sources: [...previous.sources, ...next.sources],
		warnings: [...new Set([...previous.warnings, ...next.warnings,
			...(combined.length <= 16_000 ? [] : ['Stream preview was shortened; source records retain the captured fragments.'])])],
	};
}

export function groupActivity(entries: readonly ActivityEntry[]): readonly ActivityEntry[] {
	const grouped: ActivityEntry[] = [];
	for (const entry of entries) {
		const previous = grouped.at(-1);
		const gap = previous === undefined ? Infinity : Date.parse(entry.startedAt) - Date.parse(previous.endedAt ?? previous.startedAt);
		const stream = previous === undefined ? undefined : mergeTextStream(previous, entry);
		if (stream !== undefined) { grouped[grouped.length - 1] = stream; }
		else if (previous !== undefined && sameScope(previous, entry) && gap <= 30_000
			&& previous.category === 'files' && entry.category === 'files'
			&& previous.resources.length > 0 && entry.resources.length > 0
			&& [...previous.resources, ...entry.resources].every((resource) => resource.action === 'read')
			&& [previous.status, entry.status].every((state) => state === 'completed' || state === 'running')) {
			grouped[grouped.length - 1] = mergeReads(previous, entry);
		} else if (previous !== undefined && entry.category === 'output' && previous.category === 'output'
			&& sameScope(previous, entry) && previous.title === entry.title
			&& previous.sources[0]?.correlationId === entry.sources[0]?.correlationId && previous.status === entry.status && gap >= 0 && gap <= 30_000) {
			grouped[grouped.length - 1] = { ...previous, endedAt: entry.startedAt, count: previous.count + entry.count,
				details: [{ label: 'Output', value: `${previous.details[0]?.value ?? ''}${entry.details[0]?.value ?? ''}` }],
				sources: [...previous.sources, ...entry.sources], warnings: [...new Set([...previous.warnings, ...entry.warnings])] };
		} else { grouped.push(entry); }
	}
	return grouped;
}

function operationKey(event: SessionEvent, kind: 'tool' | 'command' | 'process'): string | undefined {
	return event.correlationId === undefined ? undefined : JSON.stringify([event.sessionId, event.actor, event.payload.agentId, event.evidenceGrade, kind, event.correlationId]);
}

function operationKind(event: SessionEvent): 'tool' | 'command' | 'process' | undefined {
	if (event.kind.startsWith('tool.') || event.kind === 'file.read') { return 'tool'; }
	if (event.kind.startsWith('command.')) { return 'command'; }
	if (['process.started', 'process.completed', 'process.failed'].includes(event.kind)) { return 'process'; }
	return undefined;
}

function operationTitle(entry: ActivityEntry): string {
	if (entry.category === 'files' && entry.resources.length > 0 && entry.resources.every((resource) => resource.action === 'read')) {
		const heading = resourceTitle(entry.resources);
		return entry.status === 'failed' ? `${heading} (failed)` : entry.status === 'unknown' ? `${heading} (result not captured)` : heading;
	}
	if (entry.category === 'tool') {
		const tool = entry.tools[0];
		return `${tool?.server === undefined ? 'Tool' : 'MCP tool'}: ${tool?.server === undefined ? '' : `${tool.server} / `}${tool?.name ?? 'unnamed'}`;
	}
	return entry.title.replace(/^(?:Agent command|Managed process) started:/, 'Command:');
}

export function buildSessionActivity(events: readonly SessionEvent[]): readonly ActivityEntry[] {
	const entries: ActivityEntry[] = [];
	const seen = new Set<string>();
	const pending = new Map<string, number>();
	const ambiguous = new Set<string>();
	for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
		const key = `${event.sessionId}/${event.eventId}`;
		if (seen.has(key)) { continue; }
		seen.add(key);
		let entry = sessionEntry(event);
		const kind = operationKind(event);
		const correlation = kind === undefined ? undefined : operationKey(event, kind);
		const index = correlation === undefined ? undefined : pending.get(correlation);
		const started = index === undefined ? undefined : entries[index];
		const isStart = event.kind === 'tool.called' || event.kind.endsWith('.started');
		if (isStart && kind !== undefined && correlation !== undefined) {
			if (started !== undefined && index !== undefined) {
				entries[index] = { ...started, warnings: [...started.warnings, 'Repeated correlation ID; tool results cannot be paired safely.'] };
				ambiguous.add(correlation);
				pending.delete(correlation);
			} else if (!ambiguous.has(correlation)) { pending.set(correlation, entries.length); }
		} else if (started !== undefined && index !== undefined && event.kind === 'file.read'
			&& started.tools[0]?.name === entry.tools[0]?.name && entry.resources.length > 0) {
			entries[index] = { ...started, category: 'files', title: entry.title, resources: [...started.resources, ...entry.resources],
				sources: [...started.sources, ...entry.sources], warnings: [...new Set([...started.warnings, ...entry.warnings])] };
			continue;
		} else if (kind !== undefined && !isStart && event.kind !== 'file.read') {
			if (started !== undefined && index !== undefined && (started.tools[0]?.name === entry.tools[0]?.name || entry.tools.length === 0)) {
				const merged: ActivityEntry = { ...started, status: entry.status, endedAt: entry.startedAt,
					details: [...started.details, ...entry.details], sources: [...started.sources, ...entry.sources],
					warnings: [...new Set([...started.warnings, ...entry.warnings])] };
				entries[index] = { ...merged, title: operationTitle(merged) };
				if (correlation !== undefined) { pending.delete(correlation); }
				continue;
			}
			entry = { ...entry, endedAt: event.occurredAt, warnings: [...entry.warnings, 'Start event was not captured.'] };
		}
		entries.push({ ...entry, title: operationTitle(entry) });
	}
	const terminalSessions = new Set(events.filter((event) => ['session.completed', 'session.failed', 'session.interrupted'].includes(event.kind)).map((event) => event.sessionId));
	return groupActivity(entries.map((entry) => entry.status === 'running' && terminalSessions.has(entry.sources[0]?.sessionId ?? '')
		? { ...entry, status: 'unknown', title: operationTitle({ ...entry, status: 'unknown' }), warnings: [...entry.warnings, 'Completion event was not captured.'] }
		: entry));
}

function object(value: JsonValue | undefined): JsonObject | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
}

function string(value: JsonValue | undefined): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function fileAction(value: JsonValue | undefined): ActivityResource['action'] | undefined {
	return value === 'read' || value === 'created' || value === 'modified' || value === 'deleted' || value === 'changed' ? value : undefined;
}

function traceEntry(stored: StoredTraceSpan): ActivityEntry {
	const { span } = stored;
	const clean = redactAttributes(span.attributes, { mode: 'redacted-content', maxStringLength: 16_000 });
	const attributes = clean.attributes;
	const input = object(attributes.input);
	const server = string(attributes['mcp.server.name']) ?? string(attributes['tool.server.name']);
	const method = string(attributes['mcp.method']);
	const toolName = string(attributes['tool.name']) ?? (span.kind === 'tool' ? redactSensitiveText(span.name) : undefined);
	const path = string(input?.path) ?? string(input?.file_path) ?? string(attributes['file.path']);
	const action = fileAction(attributes['file.operation']) ?? (attributes['file.operation'] === undefined && toolName !== undefined && /^(?:read|read_file|readfile|view|imageview)$/i.test(toolName) ? 'read' : undefined);
	const resources: ActivityResource[] = span.kind === 'tool' && action !== undefined && path !== undefined
		? [{ path, type: attributes['file.type'] === 'directory' ? 'directory' : attributes['file.type'] === 'file' ? 'file' : 'path', action, count: 1 }] : [];
	const tools: ActivityTool[] = toolName === undefined && method === undefined ? [] : [{ name: toolName ?? method ?? 'MCP operation',
		...(server === undefined ? {} : { server }), ...(method === undefined ? {} : { method }) }];
	const name = redactSensitiveText(span.name);
	const provider = string(attributes['gen_ai.provider.name']) ?? string(attributes['provider.name']) ?? span.usage?.provider;
	const model = string(attributes['gen_ai.response.model']) ?? string(attributes['gen_ai.request.model']) ?? string(attributes['model.name']) ?? span.usage?.model;
	const titles: Record<string, string> = { agent: 'Agent', model: 'Model call', retrieval: 'Retrieve context', embedding: 'Create embeddings',
		rerank: 'Rerank results', memory: 'Memory', workflow: 'Workflow', custom: 'Operation' };
	const details: TimelineDetail[] = [];
	for (const [key, label] of [['input', 'Input'], ['output', 'Output'], ['error.type', 'Error']] as const) {
		const value = attributes[key];
		if (value !== undefined) { details.push({ label, value: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }); }
	}
	if (span.kind === 'model') {
		details.push({ label: 'Tokens', value: span.usage === undefined ? 'Not reported' :
			`input: ${span.usage.inputTokens ?? 'not reported'} | output: ${span.usage.outputTokens ?? 'not reported'} | total: ${span.usage.totalTokens ?? 'not reported'}` });
	}
	for (const event of span.events) {
		if (/(?:^|[._-])(?:thinking|reasoning|scratchpad)(?:$|[._-])/i.test(event.name)) { continue; }
		const eventAttributes = redactAttributes(event.attributes, { mode: 'redacted-content', maxStringLength: 16_000 }).attributes;
		details.push({ label: redactSensitiveText(event.name), value: `${event.at}${Object.keys(eventAttributes).length === 0 ? '' : `\n${JSON.stringify(eventAttributes, null, 2)}`}` });
	}
	const entry: ActivityEntry = {
		schemaVersion: 1, id: `${span.projectId}/${span.traceId}/${span.spanId}`, category: resources.length > 0 ? 'files' : span.kind,
		title: resources.length > 0 && action !== 'read'
			? `${action === 'created' ? 'Created' : action === 'modified' ? 'Modified' : action === 'deleted' ? 'Deleted' : 'Changed'} file: ${path}`
			: `${titles[span.kind] ?? 'Tool'}: ${span.kind === 'model' && (provider !== undefined || model !== undefined) ? [provider, model].filter(Boolean).join(' / ') : name}`,
		startedAt: span.startedAt, ...(span.endedAt === undefined ? {} : { endedAt: span.endedAt }),
		actor: redactSensitiveText(span.serviceName), status: span.state, count: 1, resources, tools, details,
		...(span.parentSpanId === undefined ? {} : { parentId: `${span.projectId}/${span.traceId}/${span.parentSpanId}` }),
		sources: [{ id: `${span.traceId}/${span.spanId}@${span.revision}`, kind: span.kind, at: stored.receivedAt, evidenceGrade: stored.evidenceGrade,
			projectId: span.projectId, traceId: span.traceId, spanId: span.spanId, revision: span.revision }],
		warnings: [
			...(span.capture.redactedFields === 0 ? [] : [`${span.capture.redactedFields} sensitive or excluded field(s) omitted.`]),
			...(span.capture.truncatedFields === 0 && clean.report.truncatedFields === 0 ? [] : ['Captured details were truncated.']),
			...(span.capture.droppedEvents === 0 ? [] : [`${span.capture.droppedEvents} event(s) were dropped.`]),
			...span.capture.limitations.filter((limitation) => limitation !== 'Provider-hidden reasoning is not collected.').map(redactSensitiveText),
		],
	};
	return { ...entry, title: operationTitle(entry) };
}

export function buildTraceActivity(spans: readonly StoredTraceSpan[]): readonly ActivityEntry[] {
	const latest = new Map<string, StoredTraceSpan>();
	for (const stored of spans) {
		const key = `${stored.span.projectId}/${stored.span.traceId}/${stored.span.spanId}`;
		if ((latest.get(key)?.span.revision ?? 0) < stored.span.revision) { latest.set(key, stored); }
	}
	const entries = [...latest.values()].sort((left, right) => left.span.startedAt.localeCompare(right.span.startedAt) || left.sequence - right.sequence).map(traceEntry);
	const identifiers = new Set(entries.map((entry) => entry.id));
	return groupActivity(entries.map((entry) => entry.parentId !== undefined && !identifiers.has(entry.parentId)
		? { ...entry, warnings: [...entry.warnings, 'Parent span is not in the loaded capture.'] } : entry));
}

export function formatActivityText(entry: ActivityEntry): readonly string[] {
	const lines = [`${entry.startedAt}${entry.endedAt === undefined || entry.endedAt === entry.startedAt ? '' : ` .. ${entry.endedAt}`}  ${entry.status.toUpperCase().padEnd(11)} ${entry.title}`];
	for (const resource of entry.resources) { lines.push(`  ${resource.path}${resource.count > 1 ? ` (${resource.count} reads)` : ''}`); }
	for (const tool of entry.tools) { lines.push(`  Tool: ${tool.server === undefined ? '' : `${tool.server} / `}${tool.name}${tool.method === undefined ? '' : ` (${tool.method})`}`); }
	for (const detail of entry.details) {
		lines.push(`  ${detail.label}: ${detail.value.replace(/\r\n?/g, '\n').replace(/\n/g, '\n    ')}`);
	}
	for (const warning of entry.warnings) { lines.push(`  Warning: ${warning}`); }
	return lines;
}
