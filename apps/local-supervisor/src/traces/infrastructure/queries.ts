import { StoredTraceSpanSchema, TraceSummarySchema, type StoredTraceSpan, type TraceSummary } from 'model-worklog-schema';

import { TraceError, type CleanupResult, type TracePage } from '../domain/contracts';
import { TraceDatabase, integer, text } from './database';

const MAX_PAGE_BYTES = 4 * 1024 * 1024;

export class TraceQueries {
	constructor(private readonly database: TraceDatabase) {}

	list(projectId: string, limit: number, after = Number.MAX_SAFE_INTEGER): TracePage<TraceSummary> {
		return this.database.transaction(false, () => {
			const rows = this.database.statement('SELECT sequence, summary FROM traces WHERE project_id = ? AND sequence < ? ORDER BY sequence DESC LIMIT ?').all(projectId, after, limit + 1);
			const page = rows.slice(0, limit);
			return {
				items: page.map((row) => TraceSummarySchema.parse(JSON.parse(text(row, 'summary')) as unknown)),
				...(rows.length > limit ? { after: integer(page.at(-1), 'sequence') } : {}),
			};
		});
	}

	detail(projectId: string, traceId: string, limit: number, after = 0): TracePage<StoredTraceSpan> {
		return this.database.transaction(false, () => {
			if (this.database.statement('SELECT sequence FROM traces WHERE project_id = ? AND trace_id = ?').get(projectId, traceId) === undefined) {
				throw new TraceError(404, 'trace_not_found', 'Trace not found in the authorized project.');
			}
			const candidates = this.database.statement('SELECT sequence, stored_bytes FROM spans WHERE project_id = ? AND trace_id = ? AND sequence > ? ORDER BY sequence LIMIT ?').all(projectId, traceId, after, limit + 1);
			const items: StoredTraceSpan[] = [];
			let bytes = 0;
			for (const candidate of candidates) {
				const size = integer(candidate, 'stored_bytes');
				if (items.length === limit || (items.length > 0 && bytes + size > MAX_PAGE_BYTES)) { break; }
				const sequence = integer(candidate, 'sequence');
				const row = this.database.statement('SELECT payload, received_at FROM spans WHERE sequence = ?').get(sequence);
				items.push(StoredTraceSpanSchema.parse({ span: JSON.parse(text(row, 'payload')) as unknown, receivedAt: text(row, 'received_at'), sequence, evidenceGrade: 'model-declared' }));
				bytes += size;
			}
			return { items, ...(candidates.length > items.length ? { after: items.at(-1)?.sequence } : {}) };
		});
	}

	delete(projectId: string, traceId: string): boolean {
		return this.database.transaction(true, () => {
			const row = this.database.statement('SELECT open_spans FROM traces WHERE project_id = ? AND trace_id = ?').get(projectId, traceId);
			if (row === undefined) { return false; }
			if (integer(row, 'open_spans') > 0) { throw new TraceError(409, 'trace_active', 'An active trace cannot be deleted.'); }
			this.database.statement('DELETE FROM traces WHERE project_id = ? AND trace_id = ?').run(projectId, traceId);
			return true;
		});
	}

	cleanup(projectId: string, before: string, limit: number): CleanupResult {
		return this.database.transaction(true, () => this.prune(projectId, before, limit));
	}

	protected prune(projectId: string, before: string, limit: number, excluded: ReadonlySet<string> = new Set()): CleanupResult {
		const candidates = this.database.statement('SELECT sequence, trace_id FROM traces WHERE project_id = ? AND retention_ready = 1 AND open_spans = 0 AND updated_at < ? ORDER BY updated_at, sequence LIMIT ?').all(projectId, before, limit + excluded.size + 1);
		const rows = candidates.filter((row) => !excluded.has(text(row, 'trace_id')));
		for (const row of rows.slice(0, limit)) { this.database.statement('DELETE FROM traces WHERE sequence = ?').run(integer(row, 'sequence')); }
		return { deleted: Math.min(rows.length, limit), hasMore: rows.length > limit };
	}
}