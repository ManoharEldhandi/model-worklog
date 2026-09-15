import { isApiCompatible, parseHealthResponse, type HealthResponse, type ParseIssue } from 'model-worklog-schema';

export type FetchLike = (input: string | URL, init?: {
	readonly method?: string;
	readonly signal?: AbortSignal;
	readonly headers?: Record<string, string>;
	readonly body?: string;
}) => Promise<Response>;

export type HealthOutcome =
	| { readonly kind: 'ok'; readonly url: string; readonly health: HealthResponse }
	| { readonly kind: 'incompatible'; readonly url: string; readonly health: HealthResponse }
	| { readonly kind: 'malformed'; readonly url: string; readonly issues: readonly ParseIssue[] }
	| { readonly kind: 'http-error'; readonly url: string; readonly statusCode: number }
	| { readonly kind: 'unreachable'; readonly url: string; readonly message: string };

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '::1']);

/** Parses a supervisor URL and rejects any non-loopback host. */
export function assertLoopbackUrl(raw: string): URL {
	const url = new URL(raw);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`supervisor URL must use http or https, received ${url.protocol}`);
	}
	const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(`supervisor URL must be loopback, received ${url.hostname}`);
	}
	return url;
}

export interface FetchHealthOptions {
	readonly timeoutMs?: number;
	readonly fetchImpl?: FetchLike;
}

export async function fetchHealth(rawUrl: string, options: FetchHealthOptions = {}): Promise<HealthOutcome> {
	let base: URL;
	try {
		base = assertLoopbackUrl(rawUrl);
	} catch (error) {
		return { kind: 'unreachable', url: rawUrl, message: error instanceof Error ? error.message : String(error) };
	}

	const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike);
	const target = new URL('/health', base);

	let response: Response;
	try {
		response = await fetchImpl(target, { method: 'GET', signal: AbortSignal.timeout(options.timeoutMs ?? 1500) });
	} catch (error) {
		return { kind: 'unreachable', url: target.href, message: error instanceof Error ? error.message : String(error) };
	}

	if (!response.ok) {
		return { kind: 'http-error', url: target.href, statusCode: response.status };
	}

	let json: unknown;
	try {
		json = await response.json();
	} catch {
		return { kind: 'malformed', url: target.href, issues: [{ path: '', message: 'response body was not valid JSON' }] };
	}

	const parsed = parseHealthResponse(json);
	if (!parsed.ok) {
		return { kind: 'malformed', url: target.href, issues: parsed.issues };
	}
	if (!isApiCompatible(parsed.value.apiVersion)) {
		return { kind: 'incompatible', url: target.href, health: parsed.value };
	}
	return { kind: 'ok', url: target.href, health: parsed.value };
}
