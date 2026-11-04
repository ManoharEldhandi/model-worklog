import type { SpanPersistenceInterceptor } from '../domain/logQuery';
import { TraceDatabase, integer } from './database';

export function hasSqliteFts5(database: TraceDatabase): boolean {
	return integer(database.statement("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS available").get(), 'available') === 1;
}

export class SqliteLogSearchIndex implements SpanPersistenceInterceptor {
	readonly available: boolean;

	constructor(private readonly database: TraceDatabase) { this.available = hasSqliteFts5(database); }

	initialize(): void {
		this.database.transaction(true, () => {
			this.database.statement('CREATE TABLE IF NOT EXISTS span_search_meta(id INTEGER PRIMARY KEY CHECK(id = 1), dirty INTEGER NOT NULL) STRICT').run();
			this.database.statement('INSERT OR IGNORE INTO span_search_meta VALUES (1, 1)').run();
			if (this.available) { this.initializeFts(); }
			this.database.statement("CREATE INDEX IF NOT EXISTS spans_query_kind ON spans(project_id, json_extract(payload, '$.kind'), julianday(json_extract(payload, '$.startedAt')))").run();
			this.database.statement("CREATE INDEX IF NOT EXISTS spans_query_time ON spans(project_id, julianday(json_extract(payload, '$.startedAt')))").run();
		});
	}

	beforeSpanWrite(projectId: string, traceId: string, spanId: string): void {
		if (!this.available) { this.markDirty(); return; }
		this.database.statement("INSERT INTO span_search(span_search, rowid, payload) SELECT 'delete', sequence, payload FROM spans WHERE project_id = ? AND trace_id = ? AND span_id = ?").run(projectId, traceId, spanId);
	}

	afterSpanWrite(projectId: string, traceId: string, spanId: string): void {
		if (!this.available) { return; }
		this.database.statement('INSERT INTO span_search(rowid, payload) SELECT sequence, payload FROM spans WHERE project_id = ? AND trace_id = ? AND span_id = ?').run(projectId, traceId, spanId);
	}

	beforeTraceDelete(projectId: string, traceId: string): void {
		if (!this.available) { this.markDirty(); return; }
		this.database.statement("INSERT INTO span_search(span_search, rowid, payload) SELECT 'delete', sequence, payload FROM spans WHERE project_id = ? AND trace_id = ?").run(projectId, traceId);
	}

	private markDirty(): void { this.database.statement('UPDATE span_search_meta SET dirty = 1 WHERE id = 1 AND dirty = 0').run(); }

	private initializeFts(): void {
		const exists = this.database.statement("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'span_search'").get();
		if (exists === undefined) { this.database.statement("CREATE VIRTUAL TABLE span_search USING fts5(payload, content='spans', content_rowid='sequence', tokenize='unicode61 remove_diacritics 2')").run(); }
		if (exists === undefined || integer(this.database.statement('SELECT dirty FROM span_search_meta WHERE id = 1').get(), 'dirty') !== 0) {
			this.database.statement("INSERT INTO span_search(span_search) VALUES ('rebuild')").run();
		}
		this.database.statement("INSERT INTO span_search(span_search, rank) VALUES ('secure-delete', 1)").run();
		this.database.statement('UPDATE span_search_meta SET dirty = 0 WHERE id = 1').run();
	}
}
