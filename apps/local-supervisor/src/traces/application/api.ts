import {
	ProjectIdSchema, TraceDetailSchema, TraceIdSchema, TraceListSchema, TraceSpanSchema,
	type TracePrincipal,
} from 'model-worklog-schema';

import { TraceError, type CursorCodec, type TraceRepository } from '../domain/contracts';
import { TraceCredentials, requireProject, requireRole } from './credentials';
import { TraceIntake } from './intake';

export type TraceOperation = { kind: 'identity' } | { kind: 'credential-create' } | { kind: 'batch' } | { kind: 'otlp' }
	| { kind: 'list' } | { kind: 'retention' } | { kind: 'credential-revoke'; id: string }
	| { kind: 'detail'; id: string } | { kind: 'delete'; id: string };

export interface TraceApiResult { readonly statusCode: number; readonly body: unknown }

function fields(query: URLSearchParams, allowed: readonly string[]): void {
	const seen = new Set<string>();
	for (const [key] of query) {
		if (!allowed.includes(key) || seen.has(key)) { throw new TraceError(400, 'invalid_query', 'Unknown or duplicate query parameter.'); }
		seen.add(key);
	}
}

function project(principal: TracePrincipal, input: unknown): string {
	const parsed = ProjectIdSchema.safeParse(input);
	if (!parsed.success) { throw new TraceError(400, 'invalid_project', 'An explicit valid projectId is required.'); }
	const projectId = parsed.data;
	requireProject(principal, projectId);
	return projectId;
}

function limit(input: unknown, fallback: number, maximum: number): number {
	if (input === null || input === undefined) { return fallback; }
	if (typeof input === 'string' && /^[1-9][0-9]{0,3}$/.test(input)) { input = Number(input); }
	if (typeof input !== 'number' || !Number.isInteger(input) || input < 1 || input > maximum) {
		throw new TraceError(400, 'invalid_limit', `limit must be an integer between 1 and ${maximum}.`);
	}
	return input;
}

function operation(method: string, pathname: string): TraceOperation {
	const fixed: Record<string, { method: string; kind: 'identity' | 'credential-create' | 'batch' | 'otlp' | 'list' | 'retention' }> = {
		'/v1/traces': { method: 'POST', kind: 'otlp' },
		'/v2/identity': { method: 'GET', kind: 'identity' },
		'/v2/credentials': { method: 'POST', kind: 'credential-create' },
		'/v2/traces/batch': { method: 'POST', kind: 'batch' },
		'/v2/traces': { method: 'GET', kind: 'list' },
		'/v2/traces/retention': { method: 'POST', kind: 'retention' },
	};
	const exact = fixed[pathname];
	if (exact !== undefined) {
		if (method !== exact.method) { throw new TraceError(400, 'method_not_allowed', `This endpoint requires ${exact.method}.`); }
		return { kind: exact.kind };
	}
	const credential = /^\/v2\/credentials\/([^/]+)$/.exec(pathname)?.[1];
	if (credential !== undefined) {
		if (method !== 'DELETE') { throw new TraceError(400, 'method_not_allowed', 'This endpoint requires DELETE.'); }
		return { kind: 'credential-revoke', id: credential };
	}
	const traceId = /^\/v2\/traces\/([^/]+)$/.exec(pathname)?.[1];
	if (traceId !== undefined) {
		if (method !== 'GET' && method !== 'DELETE') { throw new TraceError(400, 'method_not_allowed', 'This endpoint requires GET or DELETE.'); }
		if (!TraceIdSchema.safeParse(traceId).success) { throw new TraceError(400, 'invalid_trace_id', 'Invalid trace identifier.'); }
		return { kind: method === 'GET' ? 'detail' : 'delete', id: traceId };
	}
	throw new TraceError(404, 'not_found', 'Trace endpoint not found.');
}

export class TraceApi {
	constructor(
		readonly credentials: TraceCredentials,
		private readonly intake: TraceIntake,
		private readonly repository: TraceRepository,
		private readonly cursors: CursorCodec,
		private readonly now: () => Date,
		private readonly retentionTtlSeconds?: number,
	) {}

	authorize(principal: TracePrincipal, method: string, pathname: string): TraceOperation {
		const selected = operation(method, pathname);
		if (selected.kind === 'batch' || selected.kind === 'otlp') { requireRole(principal, ['writer', 'admin']); }
		else if (selected.kind === 'list' || selected.kind === 'detail') { requireRole(principal, ['reader', 'admin']); }
		else if (selected.kind !== 'identity') { requireRole(principal, ['admin']); }
		return selected;
	}

	otlpProject(principal: TracePrincipal, input: unknown): string {
		requireRole(principal, ['writer', 'admin']);
		return project(principal, input === undefined && principal.role === 'writer' && principal.projects.length === 1 ? principal.projects[0] : input);
	}

	handle(selected: TraceOperation, principal: TracePrincipal, query: URLSearchParams, body: unknown): TraceApiResult {
		if (selected.kind === 'list' || selected.kind === 'detail' || selected.kind === 'delete') {
			fields(query, selected.kind === 'delete' ? ['projectId'] : ['projectId', 'limit', 'cursor']);
			const projectId = project(principal, query.get('projectId'));
			if (selected.kind === 'delete') {
				if (!this.repository.delete(projectId, selected.id)) { throw new TraceError(404, 'trace_not_found', 'Trace not found in the authorized project.'); }
				return { statusCode: 200, body: { schemaVersion: 1, deleted: true } };
			}
			const scope = { projectId, ...(selected.kind === 'detail' ? { traceId: selected.id } : {}) };
			const cursor = query.get('cursor');
			const after = cursor === null ? undefined : this.cursors.decode(cursor, scope);
			const size = limit(query.get('limit'), selected.kind === 'list' ? 50 : 100, selected.kind === 'list' ? 100 : 1_000);
			if (selected.kind === 'list') {
				const page = this.repository.list(projectId, size, after);
				return { statusCode: 200, body: TraceListSchema.parse({ schemaVersion: 1, traces: page.items, nextCursor: page.after === undefined ? null : this.cursors.encode(page.after, scope) }) };
			}
			const page = this.repository.detail(projectId, selected.id, size, after);
			return { statusCode: 200, body: TraceDetailSchema.parse({ schemaVersion: 1, spans: page.items, nextCursor: page.after === undefined ? null : this.cursors.encode(page.after, scope) }) };
		}
		fields(query, []);
		switch (selected.kind) {
			case 'identity': return { statusCode: 200, body: principal };
			case 'credential-create': return { statusCode: 201, body: this.credentials.create(principal, body) };
			case 'credential-revoke':
				this.credentials.revoke(principal, selected.id);
				return { statusCode: 200, body: { schemaVersion: 1, revoked: true } };
			case 'batch': return { statusCode: 200, body: this.intake.ingest(principal, body) };
			case 'otlp':
				this.intake.ingest(principal, body);
				return { statusCode: 200, body: {} };
			case 'retention': return { statusCode: 200, body: { schemaVersion: 1, ...this.retention(principal, body) } };
		}
	}

	private retention(principal: TracePrincipal, body: unknown): { deleted: number; hasMore: boolean } {
		if (body === null || typeof body !== 'object' || Array.isArray(body)
			|| Object.keys(body).some((key) => !['projectId', 'before', 'limit'].includes(key))) {
			throw new TraceError(400, 'invalid_retention', 'Expected projectId and optional before and limit fields.');
		}
		const input = body as Record<string, unknown>;
		const projectId = project(principal, input.projectId);
		if (input.limit !== undefined && typeof input.limit !== 'number') { throw new TraceError(400, 'invalid_limit', 'Retention limit must be an integer.'); }
		const before = input.before === undefined ? (this.retentionTtlSeconds === undefined ? undefined : new Date(this.now().getTime() - this.retentionTtlSeconds * 1_000).toISOString()) : input.before;
		const parsed = TraceSpanSchema.shape.startedAt.safeParse(before);
		if (!parsed.success || Date.parse(parsed.data) > this.now().getTime()) {
			throw new TraceError(400, 'invalid_retention', 'A valid past before timestamp or configured retention TTL is required.');
		}
		return this.repository.cleanup(projectId, new Date(parsed.data).toISOString(), limit(input.limit, 25, 100));
	}
}