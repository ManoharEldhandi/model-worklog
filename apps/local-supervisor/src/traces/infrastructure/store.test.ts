import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { TraceSpanSchema, type TraceSpan } from 'model-worklog-schema';

import { TraceError, type PreparedSpan } from '../domain/contracts';
import { TraceDatabase, integer } from './database';
import { TraceFileGuard } from './files';
import { SqliteTraceRepository } from './repository';

const limits = { maxStoredSpans: 100, maxStoredBytes: 1024 * 1024, maxSpansPerTrace: 10 };

function prepared(overrides: Partial<TraceSpan> = {}): PreparedSpan {
	const span = TraceSpanSchema.parse({
		schemaVersion: 1, projectId: 'project', traceId: '1'.repeat(32), spanId: '1'.repeat(16),
		name: 'root', serviceName: 'test', kind: 'agent', state: 'completed', revision: 1,
		startedAt: '2026-10-13T00:00:00.000Z', endedAt: '2026-10-13T00:00:01.000Z',
		attributes: {}, events: [], links: [], capture: { mode: 'metadata', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] },
		...overrides,
	});
	return { span, contentHash: createHash('sha256').update(JSON.stringify(span)).digest('hex'), identityHash: span.name };
}

test('SQLite batches roll back conflicts, retain revision and sequence, and survive restart', async (context) => {
	const directory = await mkdtemp(join(tmpdir(), 'trace-store-'));
	let database: TraceDatabase | undefined;
	context.after(async () => { database?.close(); await rm(directory, { recursive: true, force: true }); });
	database = new TraceDatabase(new TraceFileGuard(directory), limits);
	let repository = new SqliteTraceRepository(database, limits);
	const first = prepared();
	assert.deepEqual(repository.ingest([first], first.span.startedAt), { schemaVersion: 1, accepted: 1, duplicates: 0 });
	const sequence = repository.detail('project', first.span.traceId, 10).items[0]?.sequence;
	const newer = prepared({ revision: 2, attributes: { 'code.function': 'parse' } });
	assert.equal(repository.ingest([newer, first, newer], first.span.startedAt).duplicates, 2);
	const second = prepared({ spanId: '2'.repeat(16), parentSpanId: first.span.spanId });
	assert.throws(() => repository.ingest([second, prepared({ revision: 2 })], first.span.startedAt), (error: unknown) => error instanceof TraceError && error.code === 'revision_conflict');
	assert.equal(repository.detail('project', first.span.traceId, 10).items.length, 1);
	assert.throws(() => repository.ingest([prepared({ revision: 3, name: 'changed' })], first.span.startedAt), /immutable/);
	assert.throws(() => repository.ingest([prepared({ revision: 3, state: 'running', endedAt: undefined })], first.span.startedAt), /terminal/);
	database.close();
	database = new TraceDatabase(new TraceFileGuard(directory), limits);
	repository = new SqliteTraceRepository(database, limits);
	assert.equal(repository.detail('project', first.span.traceId, 10).items[0]?.sequence, sequence);
	assert.equal(repository.ingest([newer], first.span.startedAt).duplicates, 1);
	assert.equal((await stat(join(directory, 'trace-store', 'traces.sqlite'))).mode & 0o777, 0o600);
});

test('quota rejects atomically and retention never deletes open descendants', async (context) => {
	const directory = await mkdtemp(join(tmpdir(), 'trace-quota-'));
	const settings = { ...limits, maxStoredSpans: 2 };
	const database = new TraceDatabase(new TraceFileGuard(directory), settings);
	context.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
	const repository = new SqliteTraceRepository(database, settings);
	const root = prepared();
	const child = prepared({ spanId: '2'.repeat(16), parentSpanId: root.span.spanId, state: 'running', endedAt: undefined });
	repository.ingest([root, child], root.span.startedAt);
	assert.throws(() => repository.ingest([prepared({ traceId: '2'.repeat(32) })], root.span.startedAt), /quota/);
	assert.equal(repository.list('project', 100).items.length, 1);
	assert.equal(repository.cleanup('project', '2027-01-01T00:00:00.000Z', 100).deleted, 0);
	assert.throws(() => repository.delete('project', root.span.traceId), /active/);
	repository.ingest([prepared({ spanId: child.span.spanId, parentSpanId: root.span.spanId, revision: 2 })], root.span.startedAt);
	assert.equal(repository.cleanup('project', '2027-01-01T00:00:00.000Z', 100).deleted, 1);
	assert.equal(repository.ingest([root], root.span.startedAt).accepted, 1);
});

test('store refuses symlink database and SQLite sidecars without changing the target', async (context) => {
	const directory = await mkdtemp(join(tmpdir(), 'trace-symlinks-'));
	context.after(async () => { await rm(directory, { recursive: true, force: true }); });
	const target = join(directory, 'unrelated');
	await writeFile(target, 'untouched', { mode: 0o600 });
	for (const suffix of ['', '-wal', '-shm', '-journal']) {
		const root = join(directory, `case${suffix}`);
		await mkdir(join(root, 'trace-store'), { recursive: true, mode: 0o700 });
		await symlink(target, join(root, 'trace-store', `traces.sqlite${suffix}`));
		assert.throws(() => new TraceFileGuard(root), /regular files/);
	}
	assert.equal((await stat(target)).size, 9);
});

test('TTL pruning is atomic with intake and preserves incoming traces and unresolved parents', async (context) => {
	const directory = await mkdtemp(join(tmpdir(), 'trace-retention-'));
	const database = new TraceDatabase(new TraceFileGuard(directory), limits);
	context.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
	const repository = new SqliteTraceRepository(database, limits);
	const first = prepared();
	const old = prepared({ traceId: '2'.repeat(32) });
	const orphan = prepared({ traceId: '3'.repeat(32), parentSpanId: '2'.repeat(16) });
	repository.ingest([first, old, orphan], first.span.startedAt);
	const before = '2026-10-14T00:00:00.000Z';
	assert.throws(() => repository.ingest([prepared({ attributes: { 'code.function': 'changed' } })], before, before), /different content/);
	assert.equal(repository.list('project', 100).items.length, 3);
	assert.equal(repository.ingest([first], before, before).duplicates, 1);
	assert.deepEqual(repository.list('project', 100).items.map((trace) => trace.traceId).sort(), [first.span.traceId, orphan.span.traceId]);
	assert.equal(repository.cleanup('project', before, 100).deleted, 1);
	assert.equal(repository.list('project', 100).items[0]?.traceId, orphan.span.traceId);
});

test('WAL read transactions retain a consistent snapshot during a concurrent connection write', async (context) => {
	const directory = await mkdtemp(join(tmpdir(), 'trace-snapshot-'));
	const files = new TraceFileGuard(directory);
	const database = new TraceDatabase(files, limits);
	const concurrent = new DatabaseSync(files.databasePath);
	context.after(async () => { concurrent.close(); database.close(); await rm(directory, { recursive: true, force: true }); });
	database.transaction(false, () => {
		const count = database.statement('SELECT COUNT(*) AS count FROM credentials');
		assert.equal(integer(count.get(), 'count'), 0);
		concurrent.prepare('INSERT INTO credentials(id, digest, role, projects, expires_at) VALUES (?, ?, ?, ?, ?)').run('snapshot', 'd'.repeat(64), 'reader', '["project"]', '2027-01-01T00:00:00.000Z');
		assert.equal(integer(count.get(), 'count'), 0);
	});
	assert.equal(database.transaction(false, () => integer(database.statement('SELECT COUNT(*) AS count FROM credentials').get(), 'count')), 1);
});