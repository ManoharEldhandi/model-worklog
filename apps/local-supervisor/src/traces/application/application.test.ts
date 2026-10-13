import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TraceCredentials } from './credentials';
import { TraceIntake } from './intake';
import { traceStorageLimits } from './options';
import { TraceDatabase } from '../infrastructure/database';
import { TraceFileGuard } from '../infrastructure/files';
import { CryptoSecrets, SignedTraceCursors } from '../infrastructure/crypto';
import { SqliteCredentialRepository } from '../infrastructure/credentials';
import { SqliteTraceRepository } from '../infrastructure/repository';

test('server-issued credentials are hashed, scoped, expiring and revocable across restart', async (context) => {
	const directory = await mkdtemp(join(tmpdir(), 'trace-credentials-'));
	const limits = traceStorageLimits();
	let clock = Date.parse('2026-10-13T00:00:00.000Z');
	const now = (): Date => new Date(clock);
	let database = new TraceDatabase(new TraceFileGuard(directory), limits);
	context.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
	let credentials = new TraceCredentials(new SqliteCredentialRepository(database, now), new CryptoSecrets(), 'admin-token', now);
	const admin = credentials.authenticate('admin-token');
	assert.equal(admin.role, 'admin');
	const writer = credentials.create(admin, { role: 'writer', projects: ['private'], ttlSeconds: 60 });
	assert.match(writer.token, /^[A-Za-z0-9_-]{43}$/);
	assert.deepEqual(credentials.authenticate(writer.token).projects, ['private']);
	assert.throws(() => credentials.create(credentials.authenticate(writer.token), { role: 'reader', projects: ['private'] }), /not permitted/);
	assert.throws(() => credentials.create(admin, { role: 'admin', projects: ['*'] }), /explicit projects/);
	const intake = new TraceIntake(new SqliteTraceRepository(database, limits), new CryptoSecrets(), {}, now);
	const span = {
		schemaVersion: 1, projectId: 'private', traceId: '1'.repeat(32), spanId: '1'.repeat(16),
		name: 'test', serviceName: 'test', kind: 'agent', state: 'running', revision: 1,
		startedAt: now().toISOString(), attributes: {}, events: [], links: [],
		capture: { mode: 'metadata', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] },
	};
	assert.throws(() => intake.ingest(credentials.authenticate(writer.token), { schemaVersion: 1, spans: [span, { ...span, projectId: 'other' }] }), /requested project/);
	assert.equal(new SqliteTraceRepository(database, limits).list('private', 10).items.length, 0);
	database.close();
	const bytes = await readFile(join(directory, 'trace-store', 'traces.sqlite'));
	assert.equal(bytes.includes(Buffer.from(writer.token)), false);
	database = new TraceDatabase(new TraceFileGuard(directory), limits);
	credentials = new TraceCredentials(new SqliteCredentialRepository(database, now), new CryptoSecrets(), 'admin-token', now);
	assert.equal(credentials.authenticate(writer.token).role, 'writer');
	clock += 60_000;
	assert.throws(() => credentials.authenticate(writer.token), /valid x-model-worklog-token/);
	const reader = credentials.create(admin, { role: 'reader', projects: ['private'] });
	credentials.revoke(admin, reader.id);
	assert.throws(() => credentials.authenticate(reader.token), /valid x-model-worklog-token/);
});

test('keyset cursors reject tampering, wrong projects and wrong trace queries', () => {
	const cursors = new SignedTraceCursors('server-only-secret');
	const cursor = cursors.encode(17, { projectId: 'private' });
	assert.equal(cursors.decode(cursor, { projectId: 'private' }), 17);
	assert.throws(() => cursors.decode(`${cursor}x`, { projectId: 'private' }), /cursor/);
	assert.throws(() => cursors.decode(cursor, { projectId: 'other' }), /cursor/);
	assert.throws(() => cursors.decode(cursor, { projectId: 'private', traceId: '1'.repeat(32) }), /cursor/);
});

test('credential generation cannot issue the administrator secret even if entropy fails', () => {
	const crypto = new CryptoSecrets();
	const credentials = new TraceCredentials({ find: () => undefined, insert: () => { assert.fail('Must not persist an elevated token.'); }, revoke: () => false }, {
		issue: () => 'admin-secret', digest: (value) => crypto.digest(value), equal: (left, right) => crypto.equal(left, right),
	}, 'admin-secret', () => new Date());
	assert.throws(() => credentials.create(credentials.authenticate('admin-secret'), { role: 'writer', projects: ['private'] }), /generation failed/);
});