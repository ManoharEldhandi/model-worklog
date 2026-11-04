import type { StoredTraceSpan } from 'model-worklog-schema';
import type { LocalSupervisorClient } from '../index';
import { validateRagScope } from './engine';
import type { LogRagScope, LogRagSource } from './types';

/** Import the reader-authorized collector corpus; no editor dependency. */
export class CollectorLogSource implements LogRagSource {
	constructor(private readonly client: Pick<LocalSupervisorClient, 'listTraces' | 'getTraceSpans'>, private readonly maxSpans = 10000) {
		if (!Number.isInteger(maxSpans) || maxSpans < 1 || maxSpans > 100000) { throw new Error('Invalid source span limit.'); }
	}
	async load(input: LogRagScope, signal: AbortSignal): ReturnType<LogRagSource['load']> {
		const scope = validateRagScope(input); const traceIds: string[] = []; const spans: StoredTraceSpan[] = [];
		const limitations = ['Collector pagination is not an atomic execution snapshot. Retained instrumentation may be incomplete.'];
		if (scope.traceId !== undefined) { traceIds.push(scope.traceId); }
		else {
			let cursor: string | undefined; const seen = new Set<string>();
			for (let page = 0; page < 100; page += 1) {
				const result = await this.client.listTraces(scope.projectId, { cursor, signal });
				if (result.traces.some((trace) => trace.projectId !== scope.projectId)) { throw new Error('Collector trace scope mismatch.'); }
				traceIds.push(...result.traces.map((trace) => trace.traceId));
				if (result.nextCursor === null) { break; }
				if (seen.has(result.nextCursor)) { throw new Error('Repeated collector cursor.'); } seen.add(result.nextCursor); cursor = result.nextCursor;
				if (page === 99) { return { spans: [], complete: false, limitations: [...limitations, 'The trace list exceeded the 100-page source limit.'] }; }
			}
		}
		let scanned = 0;
		for (const traceId of new Set(traceIds)) {
			let cursor: string | undefined; const seen = new Set<string>();
			for (let page = 0; page < 100; page += 1) {
				const result = await this.client.getTraceSpans(scope.projectId, traceId, { cursor, signal });
				for (const record of result.spans) {
					if (record.span.projectId !== scope.projectId || record.span.traceId !== traceId) { throw new Error('Collector span scope mismatch.'); }
					if (++scanned > this.maxSpans) { return { spans, complete: false, limitations: [...limitations, 'The source span limit was reached. Narrow the scope.'] }; }
					const span = record.span;
					const tool = typeof span.attributes['tool.name'] === 'string' ? span.attributes['tool.name'] : span.name;
					if ((scope.spanId === undefined || scope.spanId === span.spanId) && (scope.toolName === undefined || (span.kind === 'tool' && tool.toLowerCase() === scope.toolName.toLowerCase()))
						&& (scope.since === undefined || Date.parse(span.startedAt) >= Date.parse(scope.since)) && (scope.until === undefined || Date.parse(span.startedAt) <= Date.parse(scope.until))) { spans.push(record); }
				}
				if (result.nextCursor === null) { break; }
				if (seen.has(result.nextCursor)) { throw new Error('Repeated collector cursor.'); } seen.add(result.nextCursor); cursor = result.nextCursor;
				if (page === 99) { return { spans, complete: false, limitations: [...limitations, 'The span page limit was reached.'] }; }
			}
		}
		return { spans, complete: true, limitations };
	}
}
