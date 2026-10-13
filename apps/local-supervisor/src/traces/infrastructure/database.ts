import { DatabaseSync, type SQLOutputValue, type StatementSync } from 'node:sqlite';

import { TraceError, type TraceStorageLimits } from '../domain/contracts';
import { TraceFileGuard } from './files';

type Row = Record<string, SQLOutputValue>;

export function text(row: Row | undefined, key: string): string {
	const value = row?.[key];
	if (typeof value !== 'string') { throw new Error('Invalid trace database text.'); }
	return value;
}

export function integer(row: Row | undefined, key: string): number {
	const value = row?.[key];
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) { throw new Error('Invalid trace database integer.'); }
	return value;
}

const schema = `
CREATE TABLE IF NOT EXISTS trace_meta (
	id INTEGER PRIMARY KEY CHECK (id = 1), span_count INTEGER NOT NULL, stored_bytes INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO trace_meta VALUES (1, 0, 0);
CREATE TABLE IF NOT EXISTS traces (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, trace_id TEXT NOT NULL,
	summary TEXT NOT NULL, span_count INTEGER NOT NULL DEFAULT 0, stored_bytes INTEGER NOT NULL DEFAULT 0,
	open_spans INTEGER NOT NULL DEFAULT 0, retention_ready INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
	UNIQUE(project_id, trace_id)
) STRICT;
CREATE TABLE IF NOT EXISTS spans (
	sequence INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, trace_id TEXT NOT NULL, span_id TEXT NOT NULL,
	revision INTEGER NOT NULL, content_hash TEXT NOT NULL, identity_hash TEXT NOT NULL, state TEXT NOT NULL,
	payload TEXT NOT NULL, summary_input TEXT NOT NULL, received_at TEXT NOT NULL, stored_bytes INTEGER NOT NULL,
	UNIQUE(project_id, trace_id, span_id),
	FOREIGN KEY(project_id, trace_id) REFERENCES traces(project_id, trace_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS traces_page ON traces(project_id, sequence DESC);
CREATE INDEX IF NOT EXISTS traces_retention ON traces(project_id, retention_ready, updated_at, sequence);
CREATE INDEX IF NOT EXISTS spans_page ON spans(project_id, trace_id, sequence);
CREATE TABLE IF NOT EXISTS credentials (
	id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, role TEXT NOT NULL CHECK(role IN ('reader', 'writer')),
	projects TEXT NOT NULL, expires_at TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX IF NOT EXISTS credentials_expiry ON credentials(expires_at);
CREATE TRIGGER IF NOT EXISTS span_insert AFTER INSERT ON spans BEGIN
	UPDATE trace_meta SET span_count = span_count + 1, stored_bytes = stored_bytes + new.stored_bytes WHERE id = 1;
	UPDATE traces SET span_count = span_count + 1, stored_bytes = stored_bytes + new.stored_bytes,
		open_spans = open_spans + (new.state = 'running') WHERE project_id = new.project_id AND trace_id = new.trace_id;
END;
CREATE TRIGGER IF NOT EXISTS span_update AFTER UPDATE ON spans BEGIN
	UPDATE trace_meta SET stored_bytes = stored_bytes + new.stored_bytes - old.stored_bytes WHERE id = 1;
	UPDATE traces SET stored_bytes = stored_bytes + new.stored_bytes - old.stored_bytes,
		open_spans = open_spans + (new.state = 'running') - (old.state = 'running') WHERE project_id = new.project_id AND trace_id = new.trace_id;
END;
CREATE TRIGGER IF NOT EXISTS span_delete AFTER DELETE ON spans BEGIN
	UPDATE trace_meta SET span_count = span_count - 1, stored_bytes = stored_bytes - old.stored_bytes WHERE id = 1;
	UPDATE traces SET span_count = span_count - 1, stored_bytes = stored_bytes - old.stored_bytes,
		open_spans = open_spans - (old.state = 'running') WHERE project_id = old.project_id AND trace_id = old.trace_id;
END;`;

export class TraceDatabase {
	private readonly connection: DatabaseSync;
	private readonly statements = new Map<string, StatementSync>();
	private closed = false;

	constructor(private readonly files: TraceFileGuard, limits: TraceStorageLimits) {
		this.connection = new DatabaseSync(files.databasePath, { enableForeignKeyConstraints: true, allowExtension: false });
		try {
			this.connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; PRAGMA temp_store=MEMORY; PRAGMA trusted_schema=OFF; PRAGMA secure_delete=ON; PRAGMA wal_autocheckpoint=256; PRAGMA journal_size_limit=1048576;');
			const pageSize = integer(this.connection.prepare('PRAGMA page_size').get(), 'page_size');
			const maximumPages = Math.ceil((limits.maxStoredBytes * 2 + 16 * 1024 * 1024) / pageSize);
			this.connection.exec(`PRAGMA max_page_count=${maximumPages}`);
			this.connection.exec(schema);
			files.check();
		} catch (error) { this.connection.close(); throw error; }
	}

	statement(sql: string): StatementSync {
		let statement = this.statements.get(sql);
		if (statement === undefined) { statement = this.connection.prepare(sql); this.statements.set(sql, statement); }
		return statement;
	}

	transaction<Result>(write: boolean, operation: () => Result): Result {
		this.files.check();
		let began = false;
		try {
			this.connection.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
			began = true;
			const result = operation();
			this.files.check();
			this.connection.exec('COMMIT');
			return result;
		} catch (error) {
			if (began) { try { this.connection.exec('ROLLBACK'); } catch {} }
			const code: unknown = error instanceof Error && 'errcode' in error ? error.errcode : undefined;
			if (typeof code === 'number' && (code & 255) === 13) { throw new TraceError(507, 'storage_full', 'Trace storage is full; an administrator must clean up retained traces.'); }
			if (typeof code === 'number' && [5, 6].includes(code & 255)) { throw new TraceError(429, 'storage_busy', 'Trace storage is busy; retry later.'); }
			throw error;
		}
	}

	close(): void {
		if (this.closed) { return; }
		this.closed = true;
		try { this.files.check(); this.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
		finally { this.connection.close(); }
	}
}