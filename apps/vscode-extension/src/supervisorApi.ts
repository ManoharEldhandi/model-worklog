import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SessionEvent, TokenUsageSummary } from 'model-worklog-schema';

export interface SupervisorSession {
	readonly sessionId: string;
	readonly title?: string;
	readonly state: string;
	readonly runMode: string;
	readonly actor: string;
	readonly eventCount: number;
	readonly tokenUsage: TokenUsageSummary;
}

export interface SessionEventQuery {
	readonly afterSequence?: number;
	readonly kinds?: readonly string[];
	readonly grades?: readonly string[];
	readonly actors?: readonly string[];
	readonly path?: string;
	readonly command?: string;
}

export interface SessionEventSnapshot {
	readonly events: readonly SessionEvent[];
	readonly cursor: { readonly afterSequence: number; readonly nextSequence: number };
	readonly terminal: boolean;
}

export interface CodexSessionOptions {
	readonly model?: string;
	readonly maxDurationMs: number;
	readonly maxTokens: number;
}

export interface CopilotSessionOptions {
	readonly model?: string;
	readonly maxDurationMs: number;
}

interface ApiErrorBody {
	readonly error?: { readonly message?: string };
}

async function localToken(): Promise<string> {
	const directory = process.env.MODEL_WORKLOG_HOME ?? join(homedir(), '.model-worklog');
	const token = (await readFile(join(directory, 'auth-token'), 'utf8')).trim();
	if (token === '') {
		throw new Error('Local supervisor credential is empty.');
	}
	return token;
}

async function request<T>(baseUrl: URL, pathname: string, method = 'GET', body?: unknown): Promise<T> {
	const token = await localToken();
	let response: Response;
	try {
		response = await fetch(new URL(pathname, baseUrl), {
			method,
			headers: { 'content-type': 'application/json', 'x-model-worklog-token': token },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
			signal: AbortSignal.timeout(5_000),
		});
	} catch (error) {
		throw new Error(error instanceof Error ? error.message : String(error));
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error('The local supervisor returned invalid JSON.');
	}
	if (!response.ok) {
		const error = payload as ApiErrorBody;
		throw new Error(error.error?.message ?? `The local supervisor returned HTTP ${response.status}.`);
	}
	return payload as T;
}

export async function listSessions(baseUrl: URL): Promise<readonly SupervisorSession[]> {
	const result = await request<{ sessions?: unknown }>(baseUrl, '/v1/sessions');
	if (!Array.isArray(result.sessions)) {
		throw new Error('The local supervisor returned malformed session data.');
	}
	return result.sessions as SupervisorSession[];
}

export async function trustWorkspace(baseUrl: URL, workspacePath: string): Promise<void> {
	await request(baseUrl, '/v1/workspaces/trust', 'POST', { workspacePath });
}

export function extensionClientPath(clientId?: string): string {
	return clientId === undefined ? '/v1/extension-clients' : `/v1/extension-clients/${encodeURIComponent(clientId)}`;
}

export async function registerExtensionClient(baseUrl: URL, clientId: string): Promise<void> {
	const result = await request<{ registered?: unknown; clientId?: unknown }>(baseUrl, extensionClientPath(), 'POST', { clientId });
	if (result.registered !== true || result.clientId !== clientId) {
		throw new Error('The local supervisor returned malformed extension client data.');
	}
}

export async function releaseExtensionClient(baseUrl: URL, clientId: string): Promise<number> {
	const result = await request<{ released?: unknown; clientId?: unknown; activeClients?: unknown }>(baseUrl, extensionClientPath(clientId), 'DELETE');
	if (result.released !== true || result.clientId !== clientId || typeof result.activeClients !== 'number' || !Number.isInteger(result.activeClients) || result.activeClients < 0) {
		throw new Error('The local supervisor returned malformed extension client release data.');
	}
	return result.activeClients;
}

export function codexSessionPath(): string {
	return '/v1/codex-sessions';
}

export async function startCodexSession(baseUrl: URL, workspacePath: string, task: string, options: CodexSessionOptions): Promise<SupervisorSession> {
	const result = await request<{ session?: SupervisorSession }>(baseUrl, codexSessionPath(), 'POST', { workspacePath, task, ...options });
	if (result.session === undefined) {
		throw new Error('The local supervisor returned malformed Codex session data.');
	}
	return result.session;
}

export function copilotSessionPath(): string {
	return '/v1/copilot-sessions';
}

export async function startCopilotSession(baseUrl: URL, workspacePath: string, task: string, options: CopilotSessionOptions): Promise<SupervisorSession> {
	const result = await request<{ session?: SupervisorSession }>(baseUrl, copilotSessionPath(), 'POST', { workspacePath, task, ...options });
	if (result.session === undefined) {
		throw new Error('The local supervisor returned malformed Copilot session data.');
	}
	return result.session;
}

export function copilotInteractiveSessionPath(): string {
	return '/v1/copilot-interactive-sessions';
}

export async function startCopilotInteractiveSession(baseUrl: URL, workspacePath: string, vendorSessionId: string): Promise<SupervisorSession> {
	const result = await request<{ session?: SupervisorSession }>(baseUrl, copilotInteractiveSessionPath(), 'POST', { workspacePath, vendorSessionId });
	if (result.session === undefined) {
		throw new Error('The local supervisor returned malformed interactive Copilot session data.');
	}
	return result.session;
}

export async function cancelSession(baseUrl: URL, sessionId: string): Promise<void> {
	await request(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}/cancel`, 'POST', {});
}

export async function deleteSession(baseUrl: URL, sessionId: string): Promise<void> {
	const result = await request<{ deleted?: unknown; sessionId?: unknown }>(baseUrl, `/v1/sessions/${encodeURIComponent(sessionId)}`, 'DELETE');
	if (result.deleted !== true || result.sessionId !== sessionId) {
		throw new Error('The local Logger returned an invalid delete result.');
	}
}

export async function getSessionEvents(baseUrl: URL, sessionId: string): Promise<readonly SessionEvent[]> {
	return (await getSessionEventSnapshot(baseUrl, sessionId)).events;
}

export function evidenceBundlePath(sessionId: string): string {
	return `/v1/sessions/${encodeURIComponent(sessionId)}/evidence-bundle`;
}

export async function getEvidenceBundle(baseUrl: URL, sessionId: string): Promise<Record<string, unknown>> {
	const result = await request<{ bundle?: unknown }>(baseUrl, evidenceBundlePath(sessionId));
	if (typeof result.bundle !== 'object' || result.bundle === null || Array.isArray(result.bundle)) {
		throw new Error('The local supervisor returned malformed evidence bundle data.');
	}
	return result.bundle as Record<string, unknown>;
}

export function sessionEventQueryPath(sessionId: string, query: SessionEventQuery = {}): string {
	const parameters = new URLSearchParams();
	if (query.afterSequence !== undefined) {
		parameters.set('afterSequence', String(query.afterSequence));
	}
	for (const kind of query.kinds ?? []) {
		parameters.append('kind', kind);
	}
	for (const grade of query.grades ?? []) {
		parameters.append('grade', grade);
	}
	for (const actor of query.actors ?? []) {
		parameters.append('actor', actor);
	}
	if (query.path !== undefined) {
		parameters.set('path', query.path);
	}
	if (query.command !== undefined) {
		parameters.set('command', query.command);
	}
	const suffix = parameters.size === 0 ? '' : `?${parameters.toString()}`;
	return `/v1/sessions/${encodeURIComponent(sessionId)}/events${suffix}`;
}

export async function getSessionEventSnapshot(baseUrl: URL, sessionId: string, query?: SessionEventQuery): Promise<SessionEventSnapshot> {
	const result = await request<{ events?: unknown; cursor?: unknown; terminal?: unknown }>(baseUrl, sessionEventQueryPath(sessionId, query));
	if (!Array.isArray(result.events)) {
		throw new Error('The local supervisor returned malformed event data.');
	}
	const cursor = result.cursor as { afterSequence?: unknown; nextSequence?: unknown } | undefined;
	if (typeof cursor?.afterSequence !== 'number' || typeof cursor.nextSequence !== 'number' || typeof result.terminal !== 'boolean') {
		throw new Error('The local supervisor returned malformed event cursor data.');
	}
	return { events: result.events as SessionEvent[], cursor: { afterSequence: cursor.afterSequence, nextSequence: cursor.nextSequence }, terminal: result.terminal };
}
