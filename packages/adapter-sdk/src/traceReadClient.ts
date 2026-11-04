import { ProjectIdSchema, TraceDetailSchema, TraceIdSchema, TraceListSchema } from 'model-worklog-schema';
import { SupervisorRequestError, type FetchLike } from './index';

export interface TraceReadOptions { readonly cursor?: string; readonly limit?: number; readonly signal?: AbortSignal }
export async function readTracePage(base: URL, token: string, fetcher: FetchLike, projectId: string, traceId: string | undefined, options: TraceReadOptions): Promise<unknown> {
	ProjectIdSchema.parse(projectId); if (traceId !== undefined) { TraceIdSchema.parse(traceId); }
	const limit = options.limit ?? (traceId === undefined ? 100 : 1000);
	if (!Number.isInteger(limit) || limit < 1 || limit > (traceId === undefined ? 100 : 1000) || (options.cursor !== undefined && (!options.cursor || options.cursor.length > 4096))) { throw new Error('Invalid trace pagination options.'); }
	const query = new URLSearchParams({ projectId, limit: String(limit), ...(options.cursor === undefined ? {} : { cursor: options.cursor }) });
	const signal = AbortSignal.any([AbortSignal.timeout(10_000), ...(options.signal === undefined ? [] : [options.signal])]); signal.throwIfAborted();
	const path = traceId === undefined ? '/v2/traces' : `/v2/traces/${traceId}`;
	let response: Response;
	try { response = await fetcher(new URL(`${path}?${query}`, base), { method: 'GET', signal, redirect: 'error', cache: 'no-store', headers: { 'x-model-worklog-token': token } }); }
	catch { signal.throwIfAborted(); throw new SupervisorRequestError(0, 'The trace service is unavailable.'); }
	if (!response.ok) { await response.body?.cancel(); throw new SupervisorRequestError(response.status, `Trace service returned HTTP ${response.status}.`); }
	const reader = response.body?.getReader(); if (reader === undefined) { throw new SupervisorRequestError(200, 'The trace service returned an empty response.'); }
	try {
		const chunks: Uint8Array[] = []; let bytes = 0;
		for (;;) { const item = await reader.read(); if (item.done) { break; } bytes += item.value.byteLength; if (bytes > 4 * 1024 * 1024) { throw new Error('Trace page too large.'); } chunks.push(item.value); }
		const raw: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
		if (traceId === undefined) { const result = TraceListSchema.parse(raw); if (result.traces.some((trace) => trace.projectId !== projectId)) { throw new Error('Scope mismatch'); } return result; }
		const result = TraceDetailSchema.parse(raw); if (result.spans.some(({ span }) => span.projectId !== projectId || span.traceId !== traceId)) { throw new Error('Scope mismatch'); } return result;
	} catch { signal.throwIfAborted(); throw new SupervisorRequestError(200, 'The trace service returned invalid, oversized, or mismatched data.'); }
	finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
