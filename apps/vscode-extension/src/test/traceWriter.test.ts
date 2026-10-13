import * as assert from 'assert';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceApi } from '../traceApi';
import { PrivateWriterTokenFile, type WriterTokenStore } from '../traceWriterFile';
import { configureTraceWriter, sdkQuickstart, WriterSetupError } from '../traceWriterSetup';
import { admin, jsonResponse } from './traceFixtures';

const newToken = 'n'.repeat(43);
const oldToken = 'o'.repeat(43);

suite('Private trace writer setup', () => {
	let directory: string;
	let store: PrivateWriterTokenFile;
	let requests: string[];
	setup(async () => {
		directory = await mkdtemp(join(tmpdir(), 'model-worklog-writer-'));
		store = new PrivateWriterTokenFile({ MODEL_WORKLOG_HOME: directory });
		requests = [];
	});
	teardown(async () => { await rm(directory, { recursive: true, force: true }); });

	function api(existingProject = 'app', failRevoke = false): TraceApi {
		return new TraceApi(new URL('http://127.0.0.1:43199'), async () => 'operator-token', async (url, init) => {
			requests.push(`${init.method} ${url.pathname}`);
			if (url.pathname === '/v2/identity') {
				return jsonResponse(new Headers(init.headers).get('x-model-worklog-token') === oldToken
					? { id: 'old-id', role: 'writer', projects: [existingProject], expiresAt: '2099-01-01T00:00:00.000Z' } : admin);
			}
			if (init.method === 'POST') {
				assert.deepStrictEqual(JSON.parse(String(init.body)), { role: 'writer', projects: ['app'], ttlSeconds: 86_400 });
				return jsonResponse({ schemaVersion: 1, id: 'new-id', token: newToken, role: 'writer', projects: ['app'], expiresAt: '2099-01-01T00:00:00.000Z' }, 201);
			}
			return jsonResponse(failRevoke ? {} : { schemaVersion: 1, revoked: true }, failRevoke ? 500 : 200);
		});
	}
	const signal = (): AbortSignal => new AbortController().signal;

	test('creates a 0600 single-link file and exposes only non-secret setup metadata', async () => {
		const result = await configureTraceWriter(api(), 'app', { store, signal: signal(), confirmReplace: async () => { throw new Error('No replacement expected'); } });
		assert.ok(result);
		const stat = await lstat(result.path);
		assert.strictEqual(stat.mode & 0o777, 0o600);
		assert.strictEqual(stat.nlink, 1);
		assert.strictEqual((await readFile(result.path, 'utf8')).trim(), newToken);
		assert.ok(!JSON.stringify(result).includes(newToken));
		assert.ok(!sdkQuickstart('app').includes(newToken));
		assert.match(sdkQuickstart('app'), /createLocalModelLogger/);
		assert.match(sdkQuickstart('app'), /logger\.trace\(\{ name:/);
		assert.ok(!sdkQuickstart('app').includes('logger.span('));
	});

	test('requires deliberate replacement confirmation and revokes a replaced same-project credential', async () => {
		await writeFile(join(directory, 'trace-writer-token'), oldToken, { mode: 0o600 });
		assert.strictEqual(await configureTraceWriter(api(), 'app', { store, signal: signal(), confirmReplace: async () => false }), undefined);
		assert.strictEqual((await readFile(join(directory, 'trace-writer-token'), 'utf8')).trim(), oldToken);
		assert.ok(!requests.includes('POST /v2/credentials'));
		await configureTraceWriter(api(), 'app', { store, signal: signal(), confirmReplace: async (replacement) => {
			assert.deepStrictEqual(replacement, { projectId: 'app', expiresAt: '2099-01-01T00:00:00.000Z', status: 'active' });
			return true;
		} });
		assert.ok(requests.includes('DELETE /v2/credentials/old-id'));
	});

	test('never overwrites a valid other-project credential', async () => {
		await writeFile(join(directory, 'trace-writer-token'), oldToken, { mode: 0o600 });
		await assert.rejects(configureTraceWriter(api('other'), 'app', { store, signal: signal(), confirmReplace: async () => true }), /another project or role/);
		assert.strictEqual(await readFile(join(directory, 'trace-writer-token'), 'utf8'), oldToken);
		assert.ok(!requests.includes('POST /v2/credentials'));
	});

	test('refuses symlinks, hardlinks, public files and a symlinked home', async () => {
		const source = join(directory, 'source');
		const target = join(directory, 'trace-writer-token');
		await writeFile(source, oldToken, { mode: 0o600 });
		await symlink(source, target);
		await assert.rejects(store.inspect(), /regular file/);
		await rm(target);
		await link(source, target);
		await assert.rejects(store.inspect(), /regular file/);
		await rm(target);
		await writeFile(target, oldToken, { mode: 0o644 });
		await assert.rejects(store.inspect(), /regular file/);
		const privateDirectory = join(directory, 'private');
		const symbolicDirectory = join(directory, 'symbolic');
		await mkdir(privateDirectory, { mode: 0o700 });
		await symlink(privateDirectory, symbolicDirectory);
		await assert.rejects(new PrivateWriterTokenFile({ MODEL_WORKLOG_HOME: symbolicDirectory }).inspect(), /not a symlink/);
	});

	test('detects target changes after confirmation and revokes the newly issued credential', async () => {
		await writeFile(join(directory, 'trace-writer-token'), oldToken, { mode: 0o600 });
		await assert.rejects(configureTraceWriter(api(), 'app', { store, signal: signal(), confirmReplace: async () => {
			await chmod(join(directory, 'trace-writer-token'), 0o644);
			return true;
		} }), /newly issued credential was revoked/);
		assert.ok(requests.includes('DELETE /v2/credentials/new-id'));
		assert.strictEqual(await readFile(join(directory, 'trace-writer-token'), 'utf8'), oldToken);
	});

	test('reports failed cleanup without leaking the new token', async () => {
		const failingStore: WriterTokenStore = { inspect: () => store.inspect(), write: async () => { throw new Error(`disk failure ${newToken}`); } };
		await assert.rejects(configureTraceWriter(api('app', true), 'app', { store: failingStore, signal: signal(), confirmReplace: async () => true }), (error: unknown) => {
			assert.ok(error instanceof WriterSetupError);
			assert.strictEqual(error.credentialToRevoke, 'new-id');
			assert.ok(!error.message.includes(newToken));
			return true;
		});
		assert.ok(requests.includes('DELETE /v2/credentials/new-id'));
	});
});