import { CreateTraceCredentialSchema, TracePrincipalSchema } from 'model-worklog-schema';

import type { CreateTraceCredential, TraceCredential } from './domain/contracts';

export interface CreateTraceCredentialOptions extends Omit<CreateTraceCredential, 'ttlSeconds'> {
	readonly url: string;
	readonly adminToken: string;
	readonly ttlSeconds?: number;
}

async function responseBody(response: Response): Promise<unknown> {
	const reader = response.body?.getReader();
	if (reader === undefined) { throw new Error('Missing credential response.'); }
	try {
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		while (true) {
			const entry = await reader.read();
			if (entry.done) { break; }
			bytes += entry.value.byteLength;
			if (bytes > 16_384) { throw new Error('Credential response exceeded its size limit.'); }
			chunks.push(entry.value);
		}
		return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
	} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function createTraceCredential(options: CreateTraceCredentialOptions): Promise<TraceCredential> {
	const url = new URL(options.url);
	if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
		|| url.pathname !== '/' || url.username !== '' || url.password !== '' || /[?#@]/.test(options.url)) {
		throw new Error('Credential bootstrap requires a loopback HTTP supervisor URL without credentials, path, query or fragment.');
	}
	if (options.adminToken === '' || options.adminToken.length > 4_096 || /[\s\x00-\x1f\x7f]/.test(options.adminToken)) { throw new Error('An administrator token is required.'); }
	const input = CreateTraceCredentialSchema.parse({ role: options.role, projects: options.projects, ttlSeconds: options.ttlSeconds });
	url.pathname = '/v2/credentials';
	const response = await fetch(url, {
		method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
		headers: { 'content-type': 'application/json', 'x-model-worklog-token': options.adminToken }, body: JSON.stringify(input),
	});
	if (!response.ok) {
		await response.body?.cancel().catch(() => undefined);
		throw new Error(`Trace credential creation failed (HTTP ${response.status}).`);
	}
	try {
		const body = await responseBody(response);
		if (body === null || typeof body !== 'object' || Array.isArray(body)) { throw new Error(); }
		const value = body as Record<string, unknown>;
		if (Object.keys(value).length !== 6 || value.schemaVersion !== 1 || typeof value.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.token)) { throw new Error(); }
		const principal = TracePrincipalSchema.parse({ id: value.id, role: value.role, projects: value.projects, expiresAt: value.expiresAt });
		if (principal.role !== input.role || principal.expiresAt === undefined || principal.projects.includes('*')
			|| principal.projects.length !== new Set(input.projects).size || principal.projects.some((projectId) => !input.projects.includes(projectId))) { throw new Error(); }
		return { schemaVersion: 1, ...principal, role: principal.role, token: value.token, expiresAt: principal.expiresAt };
	} catch { throw new Error('Invalid trace credential response.'); }
}