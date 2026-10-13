import type { TraceBatchAck } from 'model-worklog-schema';

import { TraceError, type PreparedSpan, type SummarySpan, type TraceRepository, type TraceStorageLimits } from '../domain/contracts';
import { summarizeTrace, traceCanExpire } from '../domain/summary';
import { TraceDatabase, integer, text } from './database';
import { TraceQueries } from './queries';

function summaryInput(prepared: PreparedSpan): SummarySpan {
	const { spanId, parentSpanId, name, serviceName, kind, startedAt, state, usage, capture } = prepared.span;
	return { spanId, parentSpanId, name, serviceName, kind, startedAt, state, usage, capture, usageKey: prepared.usageKey };
}

export class SqliteTraceRepository extends TraceQueries implements TraceRepository {
	constructor(private readonly store: TraceDatabase, private readonly limits: TraceStorageLimits) { super(store); }

	ingest(spans: readonly PreparedSpan[], receivedAt: string, retentionBefore?: string): TraceBatchAck {
		return this.store.transaction(true, () => {
			if (retentionBefore !== undefined) {
				const projects = new Map<string, Set<string>>();
				for (const { span } of spans) {
					const traces = projects.get(span.projectId) ?? new Set<string>();
					traces.add(span.traceId);
					projects.set(span.projectId, traces);
				}
				for (const [projectId, excluded] of projects) { this.prune(projectId, retentionBefore, 10, excluded); }
			}
			let accepted = 0;
			let duplicates = 0;
			const affected = new Map<string, { projectId: string; traceId: string }>();
			for (const prepared of spans) {
				const { span, contentHash, identityHash } = prepared;
				const previous = this.store.statement('SELECT revision, content_hash, identity_hash, state FROM spans WHERE project_id = ? AND trace_id = ? AND span_id = ?').get(span.projectId, span.traceId, span.spanId);
				if (previous !== undefined) {
					const revision = integer(previous, 'revision');
					if (span.revision < revision || (span.revision === revision && text(previous, 'content_hash') === contentHash)) { duplicates += 1; continue; }
					if (span.revision === revision) { throw new TraceError(409, 'revision_conflict', 'A span revision already exists with different content.'); }
					if (text(previous, 'identity_hash') !== identityHash) { throw new TraceError(409, 'identity_conflict', 'Span parent, start, name, service and kind are immutable.'); }
					if (text(previous, 'state') !== 'running' && span.state === 'running') { throw new TraceError(409, 'terminal_span', 'A terminal span cannot return to running.'); }
				}
				this.store.statement('INSERT OR IGNORE INTO traces(project_id, trace_id, summary, updated_at) VALUES (?, ?, ?, ?)').run(span.projectId, span.traceId, '{}', receivedAt);
				const payload = JSON.stringify(span);
				if (Buffer.byteLength(payload) > 2 * 1024 * 1024) { throw new TraceError(413, 'span_too_large', 'A retained span after redaction must not exceed 2097152 bytes.'); }
				const summary = JSON.stringify(summaryInput(prepared));
				const bytes = Buffer.byteLength(payload) + Buffer.byteLength(summary) + 256;
				this.store.statement(`INSERT INTO spans(project_id, trace_id, span_id, revision, content_hash, identity_hash, state, payload, summary_input, received_at, stored_bytes)
					VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
					ON CONFLICT(project_id, trace_id, span_id) DO UPDATE SET revision = excluded.revision, content_hash = excluded.content_hash,
					state = excluded.state, payload = excluded.payload, summary_input = excluded.summary_input, received_at = excluded.received_at, stored_bytes = excluded.stored_bytes`)
					.run(span.projectId, span.traceId, span.spanId, span.revision, contentHash, identityHash, span.state, payload, summary, receivedAt, bytes);
				affected.set(`${span.projectId}/${span.traceId}`, { projectId: span.projectId, traceId: span.traceId });
				accepted += 1;
			}
			const totals = this.store.statement('SELECT span_count, stored_bytes FROM trace_meta WHERE id = 1').get();
			if (integer(totals, 'span_count') > this.limits.maxStoredSpans || integer(totals, 'stored_bytes') > this.limits.maxStoredBytes) {
				throw new TraceError(507, 'storage_quota', 'Trace storage quota exceeded; an administrator must clean up retained traces.');
			}
			for (const { projectId, traceId } of affected.values()) {
				const trace = this.store.statement('SELECT span_count FROM traces WHERE project_id = ? AND trace_id = ?').get(projectId, traceId);
				if (integer(trace, 'span_count') > this.limits.maxSpansPerTrace) { throw new TraceError(429, 'trace_quota', 'The per-trace span limit has been reached.'); }
				const inputs = this.store.statement('SELECT summary_input FROM spans WHERE project_id = ? AND trace_id = ? ORDER BY sequence LIMIT ?').all(projectId, traceId, this.limits.maxSpansPerTrace);
				const summaries = inputs.map((row) => JSON.parse(text(row, 'summary_input')) as SummarySpan);
				const summary = summarizeTrace(projectId, traceId, summaries, receivedAt);
				this.store.statement('UPDATE traces SET summary = ?, updated_at = ?, retention_ready = ? WHERE project_id = ? AND trace_id = ?').run(JSON.stringify(summary), receivedAt, Number(traceCanExpire(summaries)), projectId, traceId);
			}
			return { schemaVersion: 1, accepted, duplicates };
		});
	}
}