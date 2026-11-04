import { LogQueryRequestSchema, LogQueryResponseSchema, logQueryResponseInScope, type LogQueryInput, type LogQueryResponse } from 'model-worklog-schema';
import { SupervisorRequestError, type FetchLike } from './index';

export async function queryCapturedLogs(url: URL, token: string, fetcher: FetchLike, input: LogQueryInput, cancellation?: AbortSignal): Promise<LogQueryResponse> {
	const request = LogQueryRequestSchema.parse(input);
	const signal = AbortSignal.any([AbortSignal.timeout(55_000), ...(cancellation === undefined ? [] : [cancellation])]);
	signal.throwIfAborted();
	let response: Response;
	try {
		response = await fetcher(new URL('/v2/logs/query', url), {
			method: 'POST', redirect: 'error', cache: 'no-store', signal,
			headers: { 'content-type': 'application/json', 'x-model-worklog-token': token }, body: JSON.stringify(request),
		});
	} catch {
		signal.throwIfAborted();
		throw new SupervisorRequestError(0, 'The log query service is unavailable.');
	}
	if (!response.ok) { await response.body?.cancel(); throw new SupervisorRequestError(response.status, `Log query returned HTTP ${response.status}.`); }
	const reader = response.body?.getReader();
	if (reader === undefined) { throw new SupervisorRequestError(200, 'The log query returned an empty response.'); }
	try {
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for (;;) {
			signal.throwIfAborted();
			const chunk = await reader.read();
			if (chunk.done) { break; }
			bytes += chunk.value.byteLength;
			if (bytes > 1024 * 1024) { throw new Error('Response too large'); }
			chunks.push(chunk.value);
		}
		const result = LogQueryResponseSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))));
		if (!logQueryResponseInScope(request, result)) { throw new Error('Scope mismatch'); }
		return result;
	} catch {
		signal.throwIfAborted();
		throw new SupervisorRequestError(200, 'The log query returned invalid, oversized, or mismatched evidence.');
	} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
