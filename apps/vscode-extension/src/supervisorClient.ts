import { isApiCompatible, parseHealthResponse, type HealthResponse, type ParseIssue } from 'model-worklog-schema';

export type SupervisorConnection =
	| { readonly kind: 'connected'; readonly health: HealthResponse }
	| { readonly kind: 'incompatible'; readonly health: HealthResponse }
	| { readonly kind: 'malformed'; readonly issues: readonly ParseIssue[] }
	| { readonly kind: 'http-error'; readonly statusCode: number }
	| { readonly kind: 'unreachable'; readonly message: string };

/** Interprets a parsed health body without performing any I/O (unit-testable). */
export function interpretHealthJson(json: unknown): SupervisorConnection {
	const parsed = parseHealthResponse(json);
	if (!parsed.ok) {
		return { kind: 'malformed', issues: parsed.issues };
	}
	if (!isApiCompatible(parsed.value.apiVersion)) {
		return { kind: 'incompatible', health: parsed.value };
	}
	return { kind: 'connected', health: parsed.value };
}

export function describeConnection(connection: SupervisorConnection): { label: string; detail: string } {
	switch (connection.kind) {
		case 'connected':
			return {
				label: `connected (${connection.health.supervisorVersion})`,
				detail: `API ${connection.health.apiVersion}, instance ${connection.health.instanceId}`,
			};
		case 'incompatible':
			return {
				label: `incompatible API ${connection.health.apiVersion}`,
				detail: 'Update the extension or supervisor so their API majors match.',
			};
		case 'http-error':
			return { label: 'unavailable', detail: `supervisor returned HTTP ${connection.statusCode}` };
		case 'malformed':
			return { label: 'unavailable', detail: 'supervisor returned a malformed health response' };
		case 'unreachable':
			return { label: 'not connected', detail: connection.message };
	}
}

export function missingSupervisorFeatures(connection: SupervisorConnection, requiredFeatures: readonly string[]): readonly string[] {
	if (connection.kind !== 'connected') {
		return [...requiredFeatures];
	}
	return requiredFeatures.filter((feature) => !connection.health.capabilities.features.includes(feature));
}

export type FetchLike = (input: URL, init?: { signal?: AbortSignal }) => Promise<Response>;

/** Fetches and interprets supervisor health from a validated loopback URL. */
export async function probeSupervisor(baseUrl: URL, fetchImpl?: FetchLike): Promise<SupervisorConnection> {
	const doFetch = fetchImpl ?? (globalThis.fetch as FetchLike);
	let response: Response;
	try {
		response = await doFetch(new URL('/health', baseUrl), { signal: AbortSignal.timeout(1500) });
	} catch (error) {
		return { kind: 'unreachable', message: error instanceof Error ? error.message : String(error) };
	}
	if (!response.ok) {
		return { kind: 'http-error', statusCode: response.status };
	}
	let json: unknown;
	try {
		json = await response.json();
	} catch {
		return { kind: 'malformed', issues: [{ path: '', message: 'response body was not valid JSON' }] };
	}
	return interpretHealthJson(json);
}
