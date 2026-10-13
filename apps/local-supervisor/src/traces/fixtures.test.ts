import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';

import { TraceSpanSchema, type TraceSpan } from 'model-worklog-schema';

import { startSupervisor, type RunningSupervisor, type StartOptions } from '../server';
import { createTraceCredential } from './bootstrap';
import type { TraceCredential } from './domain/contracts';

export async function fixture(context: TestContext, options: StartOptions = {}): Promise<{ supervisor: RunningSupervisor; directory: string }> {
	const directory = await mkdtemp(join(tmpdir(), 'supervisor-traces-'));
	let supervisor: RunningSupervisor | undefined;
	context.after(async () => { try { await supervisor?.close(); } finally { await rm(directory, { recursive: true, force: true }); } });
	supervisor = await startSupervisor({ dataDirectory: directory, port: 0, ...options });
	return { supervisor, directory };
}

export function api(supervisor: RunningSupervisor, path: string, token = supervisor.authToken, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return fetch(new URL(path, supervisor.url), {
		method, headers: { 'content-type': 'application/json', 'x-model-worklog-token': token, ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

export function credential(supervisor: RunningSupervisor, role: 'reader' | 'writer', projects = ['project'], ttlSeconds?: number): Promise<TraceCredential> {
	return createTraceCredential({ url: supervisor.url, adminToken: supervisor.authToken, role, projects, ttlSeconds });
}

export function traceSpan(overrides: Partial<TraceSpan> = {}): TraceSpan {
	return TraceSpanSchema.parse({
		schemaVersion: 1, projectId: 'project', traceId: '1'.repeat(32), spanId: '1'.repeat(16),
		name: 'root', serviceName: 'test', kind: 'agent', state: 'completed', revision: 1,
		startedAt: '2026-10-13T00:00:00.000Z', endedAt: '2026-10-13T00:00:01.000Z',
		attributes: {}, events: [], links: [],
		capture: { mode: 'metadata', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] },
		...overrides,
	});
}