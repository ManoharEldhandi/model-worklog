import type { HealthResponse } from 'model-worklog-schema';

export interface HttpResult {
	readonly statusCode: number;
	readonly body: unknown;
}

export interface RouteContext {
	readonly health: HealthResponse;
}

function errorBody(code: string, message: string): unknown {
	return { error: { code, message } };
}

/**
 * Pure request router. Phase 0A serves only `GET /health`; every other path or
 * method returns a structured error so behavior is testable without sockets.
 */
export function route(method: string, pathname: string, context: RouteContext): HttpResult {
	if (pathname !== '/health') {
		return { statusCode: 404, body: errorBody('not_found', `unknown path ${pathname}`) };
	}
	if (method !== 'GET' && method !== 'HEAD') {
		return { statusCode: 405, body: errorBody('method_not_allowed', `method ${method} is not allowed on ${pathname}`) };
	}
	return { statusCode: 200, body: context.health };
}
