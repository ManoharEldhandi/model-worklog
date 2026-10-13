import type { StoredTraceSpan, TraceSummary } from 'model-worklog-schema';
import { TraceApi, type TraceFetch } from '../traceApi';

export const traceId = '1'.repeat(32);
export const admin = { id: 'operator', role: 'admin', projects: ['*'] };
export const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });
export function traceSummary(overrides: Partial<TraceSummary> = {}): TraceSummary {
	return { projectId: 'app', traceId, name: 'A trace', serviceName: 'test-service', state: 'completed',
		startedAt: '2026-10-13T10:00:00.000Z', updatedAt: '2026-10-13T10:00:01.000Z', spanCount: 1, incomplete: false, ...overrides };
}
export function storedSpan(overrides: Partial<StoredTraceSpan['span']> = {}): StoredTraceSpan {
	return { span: { schemaVersion: 1, projectId: 'app', traceId, spanId: '1'.repeat(16), name: 'A span', serviceName: 'test-service', kind: 'model',
		startedAt: '2026-10-13T10:00:00.000Z', endedAt: '2026-10-13T10:00:01.000Z', state: 'completed', revision: 2,
		attributes: {}, events: [], links: [], capture: { mode: 'metadata', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] }, ...overrides },
		receivedAt: '2026-10-13T10:00:01.100Z', sequence: 1, evidenceGrade: 'model-declared' };
}
export function mockTraceApi(fetcher: TraceFetch): TraceApi {
	return new TraceApi(new URL('http://127.0.0.1:43199'), async () => 'isolated-test-token', (url, init) =>
		url.pathname === '/v2/identity' ? Promise.resolve(jsonResponse(admin)) : fetcher(url, init));
}
export function deferred<Value>(): { promise: Promise<Value>; resolve(value: Value): void } {
	let resolve!: (value: Value) => void;
	const promise = new Promise<Value>((complete) => { resolve = complete; });
	return { promise, resolve };
}