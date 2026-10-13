import {
	CreateTraceCredentialSchema, ProjectIdSchema, TraceDetailSchema, TraceIdSchema,
	TraceListSchema, TracePrincipalSchema, type TracePrincipal,
} from 'model-worklog-schema';

import { localToken } from './supervisorApi';

const CredentialSchema = TracePrincipalSchema.extend({
	schemaVersion: TraceListSchema.shape.schemaVersion,
	token: TracePrincipalSchema.shape.id.regex(/^[a-zA-Z0-9_-]{43}$/),
	role: CreateTraceCredentialSchema.shape.role,
	projects: CreateTraceCredentialSchema.shape.projects,
	expiresAt: TracePrincipalSchema.shape.expiresAt.unwrap(),
});

export type TraceCredential = ReturnType<typeof CredentialSchema.parse>;
export type TraceList = ReturnType<typeof TraceListSchema.parse>;
export type TraceDetail = ReturnType<typeof TraceDetailSchema.parse>;
export type TraceFetch = (url: URL, init: RequestInit) => Promise<Response>;
export type TraceAccess = 'read' | 'admin';

export class TraceApiError extends Error {
	constructor(readonly kind: 'unauthorized' | 'forbidden' | 'invalid-response' | 'unavailable' | 'bounds', message: string) {
		super(message);
	}
}

export function canAccessTrace(principal: TracePrincipal | undefined, projectId: string, access: TraceAccess): boolean {
	return principal !== undefined
		&& (principal.expiresAt === undefined || Date.parse(principal.expiresAt) > Date.now())
		&& (principal.projects.includes('*') || principal.projects.includes(projectId))
		&& (principal.role === 'admin' || (access === 'read' && principal.role === 'reader'));
}

function validated<Value>(schema: { safeParse(input: unknown): { success: true; data: Value } | { success: false } }, input: unknown): Value {
	const result = schema.safeParse(input);
	if (!result.success) { throw new TraceApiError('invalid-response', 'The supervisor returned invalid trace data.'); }
	return result.data;
}

export class TraceApi {
	private readonly baseUrl: URL;

	constructor(baseUrl: URL, private readonly credential: () => Promise<string> = localToken, private readonly fetcher: TraceFetch = globalThis.fetch) {
		this.baseUrl = new URL(baseUrl);
		if (baseUrl.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)
			|| baseUrl.username || baseUrl.password || baseUrl.search || baseUrl.hash || baseUrl.pathname !== '/') {
			throw new Error('Trace access requires a loopback HTTP origin without credentials.');
		}
	}

	async identity(signal?: AbortSignal): Promise<TracePrincipal> {
		return validated(TracePrincipalSchema, await this.request('/v2/identity', signal));
	}

	withCredential(credential: () => Promise<string>): TraceApi {
		return new TraceApi(this.baseUrl, credential, this.fetcher);
	}

	async list(projectId: string, cursor?: string, signal?: AbortSignal): Promise<TraceList> {
		await this.authorize(projectId, 'read', signal);
		const result = validated(TraceListSchema, await this.request(this.path('/v2/traces', projectId, 50, cursor), signal));
		if (result.traces.some((trace) => trace.projectId !== projectId)) { throw this.scopeError(); }
		return result;
	}

	async detail(projectId: string, traceId: string, cursor?: string, signal?: AbortSignal): Promise<TraceDetail> {
		TraceIdSchema.parse(traceId);
		await this.authorize(projectId, 'read', signal);
		const result = validated(TraceDetailSchema, await this.request(this.path(`/v2/traces/${traceId}`, projectId, 100, cursor), signal));
		if (result.spans.some(({ span }) => span.projectId !== projectId || span.traceId !== traceId)) { throw this.scopeError(); }
		return result;
	}

	async deleteTrace(projectId: string, traceId: string, signal?: AbortSignal): Promise<void> {
		TraceIdSchema.parse(traceId);
		await this.authorize(projectId, 'admin', signal);
		this.requireAck(await this.request(this.path(`/v2/traces/${traceId}`, projectId), signal, 'DELETE'), 'deleted');
	}

	async createWriter(projectId: string, signal?: AbortSignal): Promise<TraceCredential> {
		await this.authorize(projectId, 'admin', signal);
		const body = CreateTraceCredentialSchema.parse({ role: 'writer', projects: [projectId], ttlSeconds: 86_400 });
		const result = validated(CredentialSchema, await this.request('/v2/credentials', signal, 'POST', body));
		if (result.role !== 'writer' || result.projects.length !== 1 || result.projects[0] !== projectId) { throw this.scopeError(); }
		return result;
	}

	async revokeCredential(id: string, signal?: AbortSignal): Promise<void> {
		const principal = await this.identity(signal);
		if (principal.role !== 'admin') { throw new TraceApiError('forbidden', 'An admin credential is required.'); }
		TracePrincipalSchema.shape.id.parse(id);
		this.requireAck(await this.request(`/v2/credentials/${encodeURIComponent(id)}`, signal, 'DELETE'), 'revoked');
	}

	private async authorize(projectId: string, access: TraceAccess, signal?: AbortSignal): Promise<void> {
		ProjectIdSchema.parse(projectId);
		if (!canAccessTrace(await this.identity(signal), projectId, access)) {
			throw new TraceApiError('forbidden', access === 'admin' ? 'An admin credential for this project is required.' : 'A reader or admin credential for this project is required.');
		}
	}

	private path(pathname: string, projectId: string, limit?: number, cursor?: string): string {
		const query = new URLSearchParams({ projectId });
		if (limit !== undefined) { query.set('limit', String(limit)); }
		if (cursor !== undefined) {
			if (cursor.length === 0 || cursor.length > 4_096) { throw new TraceApiError('bounds', 'Invalid trace pagination cursor.'); }
			query.set('cursor', cursor);
		}
		return `${pathname}?${query}`;
	}

	private scopeError(): TraceApiError {
		return new TraceApiError('invalid-response', 'The supervisor returned data outside the requested trace or project.');
	}

	private requireAck(input: unknown, field: 'deleted' | 'revoked'): void {
		if (typeof input !== 'object' || input === null || !('schemaVersion' in input) || input.schemaVersion !== 1
			|| !(field in input) || input[field as keyof typeof input] !== true || Object.keys(input).length !== 2) {
			throw new TraceApiError('invalid-response', 'The supervisor did not confirm the requested action.');
		}
	}

	private async request(path: string, cancellation?: AbortSignal, method = 'GET', body?: unknown): Promise<unknown> {
		const signal = AbortSignal.any([AbortSignal.timeout(5_000), ...(cancellation === undefined ? [] : [cancellation])]);
		let token: string;
		try { token = (await this.credential()).trim(); }
		catch { throw new TraceApiError('unauthorized', 'The local supervisor credential is unavailable. Enable or reconnect Model Logger.'); }
		if (!token || /[\r\n]/.test(token)) { throw new TraceApiError('unauthorized', 'The local supervisor credential is invalid.'); }
		signal.throwIfAborted();
		let response: Response;
		try {
			response = await this.fetcher(new URL(path, this.baseUrl), {
				method, signal, redirect: 'error', cache: 'no-store',
				headers: { 'content-type': 'application/json', 'x-model-worklog-token': token },
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
			});
		} catch {
			signal.throwIfAborted();
			throw new TraceApiError('unavailable', 'Trace service unavailable. Reconnect Model Logger and retry.');
		}
		if (!response.ok) {
			await response.body?.cancel();
			throw new TraceApiError(response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : 'unavailable', `Trace service returned HTTP ${response.status}. Reconnect or check project permissions.`);
		}
		const reader = response.body?.getReader();
		if (reader === undefined) { throw new TraceApiError('invalid-response', 'The supervisor returned an empty response.'); }
		const decoder = new TextDecoder();
		let text = '';
		let bytes = 0;
		try {
			for (;;) {
				signal.throwIfAborted();
				const chunk = await reader.read();
				if (chunk.done) { break; }
				bytes += chunk.value.byteLength;
				if (bytes > 4 * 1_024 * 1_024) { throw new TraceApiError('bounds', 'Trace response exceeds the 4 MiB safety limit.'); }
				text += decoder.decode(chunk.value, { stream: true });
			}
			text += decoder.decode();
			return JSON.parse(text, (key: string, value: unknown) => {
				if (['__proto__', 'prototype', 'constructor'].includes(key)) { throw new Error('Unsafe JSON key'); }
				return value;
			}) as unknown;
		} catch (error) {
			signal.throwIfAborted();
			if (error instanceof TraceApiError) { throw error; }
			throw new TraceApiError('invalid-response', 'The supervisor returned invalid trace JSON.');
		} finally {
			await reader.cancel().catch(() => undefined);
			reader.releaseLock();
		}
	}
}