import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { TraceSpan } from 'model-worklog-schema';

import { DiskTraceSpool } from './diskSpool';
import { createModelLogger } from './logger';
import type { TraceSpool } from './spool';

async function temporaryHome(): Promise<string> { return mkdtemp(join(await realpath(tmpdir()), 'model-worklog-spool-')); }

function snapshot(): TraceSpan {
	return {
		schemaVersion: 1, projectId: 'test', serviceName: 'sdk', name: 'span', kind: 'tool', traceId: 'a'.repeat(32), spanId: 'b'.repeat(16),
		state: 'running', revision: 1, startedAt: '2026-10-13T00:00:00.000Z', links: [], attributes: { password: 'private-value', reasoning: 'hidden-value' }, events: [],
		capture: { mode: 'metadata', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] },
	};
}

test('durable snapshots are private and redacted on disk, survive restart, and are removed only after acknowledgement', async () => {
	const home = await temporaryHome();
	try {
		const directory = join(home, 'writer');
		const privacy = { mode: 'redacted-content' as const };
		const spool = await DiskTraceSpool.open({ directory, privacy });
		const logger = createModelLogger({
			projectId: 'test', serviceName: 'sdk', privacy, spool, flushIntervalMs: 0, onDiagnostic: () => undefined,
			exporter: { export: async () => { throw new Error('offline'); } },
		});
		assert.equal(await logger.trace({ name: 'durable', input: { password: 'private-value', thinking: 'hidden-value', content: 'visible' } }, async () => 7), 7);
		const failed = await logger.shutdown();
		assert.equal(failed.success, false);
		assert.equal(failed.durablePending, 2);
		assert.equal(failed.unpersisted, 0);
		assert.equal(failed.lossRisk, false);
		assert.equal((await stat(directory)).mode & 0o777, 0o700);
		for (const filename of await readdir(directory)) {
			assert.match(filename, /^[a-f0-9-]+\.json$/);
			assert.equal((await stat(join(directory, filename))).mode & 0o777, 0o600);
			const content = await readFile(join(directory, filename), 'utf8');
			assert.ok(!content.includes('private-value') && !content.includes('hidden-value'));
		}
		const recovered: TraceSpan[] = [];
		const restarted = createModelLogger({
			projectId: 'test', serviceName: 'sdk', privacy, spool: await DiskTraceSpool.open({ directory, privacy }), flushIntervalMs: 0,
			exporter: { export: async (batch) => { recovered.push(...batch.spans); return { schemaVersion: 1, accepted: 0, duplicates: batch.spans.length }; } },
		});
		assert.equal((await restarted.shutdown()).success, true);
		assert.deepEqual(recovered.map((span) => span.revision).sort(), [1, 2]);
		assert.equal(await spool.count(), 0);
	} finally { await rm(home, { recursive: true, force: true }); }
});

test('spool rejects symlink directories, parents, files, and path traversal identifiers', async () => {
	const home = await temporaryHome();
	try {
		const directory = join(home, 'writer');
		const spool = await DiskTraceSpool.open({ directory });
		await symlink(directory, join(home, 'alias'));
		await assert.rejects(DiskTraceSpool.open({ directory: join(home, 'alias') }), /Unsafe/);
		await assert.rejects(DiskTraceSpool.open({ directory: join(home, 'alias', 'nested') }), /Unsafe/);
		const id = await spool.append(snapshot());
		await unlink(join(directory, id));
		const outside = join(home, 'outside');
		await writeFile(outside, 'private-secret', { mode: 0o600 });
		await symlink(outside, join(directory, id));
		await assert.rejects(spool.read(10), /symlinks/);
		await assert.rejects(spool.remove(id));
		await assert.rejects(spool.remove('../outside'), /identifier/);
		assert.equal(await readFile(outside, 'utf8'), 'private-secret');
	} finally { await rm(home, { recursive: true, force: true }); }
});

test('replay validates strict schemas, rejects oversized records, and re-applies the current privacy policy', async () => {
	const home = await temporaryHome();
	try {
		const spool = await DiskTraceSpool.open({ directory: home });
		const id = await spool.append(snapshot());
		const path = join(home, id);
		await writeFile(path, JSON.stringify({ ...snapshot(), unexpected: 'field' }));
		await assert.rejects(spool.read(1));
		await writeFile(path, 'x'.repeat(65_537));
		await assert.rejects(spool.read(1), /Unsafe/);
		await writeFile(path, JSON.stringify({ ...snapshot(), attributes: { prompt: 'injected-private', 'gen_ai.request.model': 'model' } }));
		const replay = await spool.read(1);
		assert.deepEqual(replay[0]?.span.attributes, { 'gen_ai.request.model': 'model' });
		assert.ok(Object.isFrozen(replay[0]?.span));
	} finally { await rm(home, { recursive: true, force: true }); }
});

test('full disk spool and failed persistence leave explicit memory-loss risk without affecting application results', async () => {
	const home = await temporaryHome();
	try {
		const real = await DiskTraceSpool.open({ directory: home, maxFiles: 1 });
		const broken: TraceSpool = { append: async () => { throw new Error('disk-secret'); }, read: async () => [], remove: async () => undefined, count: async () => 0 };
		for (const spool of [real, broken]) {
			let exports = 0;
			const logger = createModelLogger({
				projectId: 'test', serviceName: 'sdk', spool, flushIntervalMs: 0, onDiagnostic: () => undefined,
				exporter: { export: async (batch) => { exports += 1; return { schemaVersion: 1, accepted: batch.spans.length, duplicates: 0 }; } },
			});
			assert.equal(await logger.trace({ name: 'still-working' }, async () => 42), 42);
			const result = await logger.shutdown();
			assert.equal(result.success, false);
			assert.ok(result.unpersisted > 0);
			assert.equal(result.lossRisk, true);
			assert.equal(exports, 0);
		}
	} finally { await rm(home, { recursive: true, force: true }); }
});

test('acknowledged snapshots replay identically when spool privacy is stricter than logger privacy', async () => {
	const directory = await temporaryHome();
	try {
		const disk = await DiskTraceSpool.open({ directory });
		const retained = new Map<string, string>();
		const exporter = { export: async (batch: { spans: readonly TraceSpan[] }) => {
			let duplicates = 0;
			for (const span of batch.spans) {
				const key = `${span.traceId}/${span.spanId}/${span.revision}`;
				const encoded = JSON.stringify(span);
				const previous = retained.get(key);
				if (previous !== undefined) { assert.equal(encoded, previous, 'A replay must not conflict with its acknowledged revision'); duplicates += 1; }
				else { retained.set(key, encoded); }
			}
			return { schemaVersion: 1 as const, accepted: batch.spans.length - duplicates, duplicates };
		} };
		const failureAfterAck: TraceSpool = {
			prepare: (span) => disk.prepare(span), append: (span) => disk.append(span), read: (limit) => disk.read(limit), count: () => disk.count(),
			remove: async () => { throw new Error('Simulated crash before cleanup'); },
		};
		const first = createModelLogger({ projectId: 'test', serviceName: 'sdk', privacy: { mode: 'redacted-content' }, spool: failureAfterAck, exporter, flushIntervalMs: 0, onDiagnostic: () => undefined });
		await first.trace({ name: 'replayed', input: { prompt: 'must not leave metadata spool policy', token: 'secret' } }, async () => 'done');
		assert.equal((await first.shutdown()).success, false);
		assert.equal(retained.size, 2);
		assert.ok([...retained.values()].every((value) => !value.includes('must not leave')));
		const second = createModelLogger({ projectId: 'test', serviceName: 'sdk', privacy: { mode: 'redacted-content' }, spool: await DiskTraceSpool.open({ directory }), exporter, flushIntervalMs: 0 });
		const result = await second.shutdown();
		assert.equal(result.success, true);
		assert.equal(result.duplicates, 2);
		assert.equal(await disk.count(), 0);
	} finally { await rm(directory, { recursive: true, force: true }); }
});