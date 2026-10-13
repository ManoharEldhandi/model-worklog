import { StoredTraceSpanSchema, TraceIdSchema, TraceSummarySchema, type TraceSummary } from 'model-worklog-schema';
import type { TraceApi } from './traceApi';
import { readTraceSpans, TRACE_EXPORT_PAGE_LIMIT } from './tracePages';
import { buildSpanForest, traceWarnings } from './tracePresentation';
import { publicStoredSpan, TRACE_CAPTURE_SCOPE } from './tracePrivacy';

export async function exportTrace(api: TraceApi, projectId: string, traceId: string, signal: AbortSignal, summary?: TraceSummary) {
	TraceIdSchema.parse(traceId);
	if (summary !== undefined) {
		TraceSummarySchema.parse(summary);
		if (summary.traceId !== traceId || summary.projectId !== projectId) { throw new Error('Export summary does not match the selected trace.'); }
	}
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(60_000)]);
	const collected = await readTraceSpans(api, projectId, traceId, TRACE_EXPORT_PAGE_LIMIT, bounded, false);
	const forest = buildSpanForest(collected.items);
	const warnings = traceWarnings(forest, summary);
	warnings.push('Pagination is not a point-in-time snapshot; concurrent writes may change retained spans.');
	if (forest.nodes.length !== collected.items.length) { warnings.push('Duplicate span revisions were received during pagination; only the latest received revision is exported.'); }
	return {
		schemaVersion: 1, projectId, traceId, exportedAt: new Date().toISOString(),
		metadata: {
			captureScope: TRACE_CAPTURE_SCOPE, underlyingExecutionComplete: false,
			allAvailablePagesCollected: true, pageCount: collected.pages, spanCount: forest.nodes.length,
			captureModes: [...new Set(forest.nodes.map(({ stored }) => stored.span.capture.mode))],
			missingParentSpanIds: forest.missingParents, cyclicSpanIds: forest.cycles, warnings,
			privacy: 'Supervisor-retained trace data only, with additional credential-like text redaction. Review before sharing.',
		},
		spans: forest.nodes.map(({ stored }) => StoredTraceSpanSchema.parse(publicStoredSpan(stored))),
	};
}