import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, symlink, writeFile, link } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { startSupervisor, type RunningSupervisor, type StartOptions } from '../server';
import { api, fixture } from './fixtures.test';

const execute = promisify(execFile);

async function expectRejectedStartup(options: StartOptions, reason: RegExp): Promise<void> {
	await assert.rejects(async () => {
		const supervisor = await startSupervisor(options);
		await supervisor.close();
	}, reason);
}

function rawPost(supervisor: RunningSupervisor, headers: Record<string, string>, body: string | Buffer): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const outgoing = request(`${supervisor.url}/v2/traces/batch`, { method: 'POST', headers }, (response) => {
			const chunks: Buffer[] = [];
			response.on('data', (chunk: Buffer) => { chunks.push(chunk); });
			response.once('end', () => { resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }); });
			response.once('error', reject);
		});
		outgoing.once('error', reject);
		outgoing.end(body);
	});
}

test('chunked body limits, incomplete unauthenticated bodies and invalid UTF-8 are handled before intake', async (context) => {
	const { supervisor } = await fixture(context);
	const headers = { 'x-model-worklog-token': supervisor.authToken, 'content-type': 'application/json' };
	assert.equal((await rawPost(supervisor, { ...headers, 'transfer-encoding': 'chunked' }, 'x'.repeat(2_097_153))).status, 413);
	assert.equal((await rawPost(supervisor, { 'content-length': '9000000' }, '{')).status, 401);
	assert.equal((await rawPost(supervisor, headers, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d]))).status, 400);
	assert.equal((await rawPost(supervisor, { ...headers, host: 'attacker.example' }, '{')).status, 403);
	assert.equal((await api(supervisor, '/v2/identity', undefined, 'GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
	assert.equal((await api(supervisor, '/v2/identity', undefined, 'GET', undefined, { origin: 'null' })).status, 403);
	assert.equal((await api(supervisor, '/v2/identity')).status, 200);
});

test('an aborted authenticated body does not leave an unhandled asynchronous exception', async (context) => {
	const { supervisor } = await fixture(context);
	await new Promise<void>((resolve) => {
		const outgoing = request(`${supervisor.url}/v2/traces/batch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-model-worklog-token': supervisor.authToken, 'content-length': '100' } });
		outgoing.once('error', () => { resolve(); });
		outgoing.once('socket', (socket) => {
			socket.once('connect', () => { outgoing.write('{'); setImmediate(() => { outgoing.destroy(); resolve(); }); });
		});
		outgoing.flushHeaders();
	});
	assert.equal((await api(supervisor, '/v2/identity')).status, 200);
});

test('credential, database, sidecar and store symlinks are refused without modifying unrelated files', async (context) => {
	const directory = await mkdtemp(join(tmpdir(), 'trace-file-denial-'));
	context.after(async () => { await rm(directory, { recursive: true, force: true }); });
	const target = join(directory, 'unrelated');
	await writeFile(target, 'unrelated contents', { mode: 0o644 });
	await chmod(target, 0o644);
	const paths = ['auth-token', 'trace-writer-token', 'supervisor.lock', 'trace-store/traces.sqlite', 'trace-store/traces.sqlite-wal', 'trace-store/traces.sqlite-shm', 'trace-store/traces.sqlite-journal'];
	for (const [index, path] of paths.entries()) {
		const root = join(directory, `case-${index}`);
		await mkdir(join(root, 'trace-store'), { recursive: true, mode: 0o700 });
		await symlink(target, join(root, path));
		await expectRejectedStartup({ dataDirectory: root, traceProjectId: 'project' }, /regular files/);
		if (path.startsWith('trace-store')) { await assert.rejects(stat(join(root, 'supervisor.lock')), { code: 'ENOENT' }); }
	}
	const linkedRoot = join(directory, 'linked-root');
	await symlink(directory, linkedRoot);
	await expectRejectedStartup({ dataDirectory: linkedRoot }, /directory/);
	const nested = join(directory, 'nested');
	await mkdir(nested, { mode: 0o700 });
	await symlink(directory, join(nested, 'trace-store'));
	await expectRejectedStartup({ dataDirectory: nested }, /directory/);
	assert.equal(await readFile(target, 'utf8'), 'unrelated contents');
	assert.equal((await stat(target)).mode & 0o777, 0o644);
});

test('special files, hard links and non-private existing credential files are refused', { skip: process.platform === 'win32', timeout: 10_000 }, async (context) => {
	const directory = await mkdtemp(join(tmpdir(), 'trace-special-denial-'));
	context.after(async () => { await rm(directory, { recursive: true, force: true }); });
	for (const [index, path] of ['trace-writer-token', 'trace-store/traces.sqlite'].entries()) {
		const root = join(directory, `fifo-${index}`);
		await mkdir(join(root, 'trace-store'), { recursive: true, mode: 0o700 });
		await execute('mkfifo', [join(root, path)]);
		await expectRejectedStartup({ dataDirectory: root }, /regular files/);
	}
	const root = join(directory, 'hard-link');
	await mkdir(root, { mode: 0o700 });
	const target = join(directory, 'private-target');
	await writeFile(target, 'user-token', { mode: 0o600 });
	await link(target, join(root, 'auth-token'));
	await expectRejectedStartup({ dataDirectory: root }, /regular files/);
	const wide = join(directory, 'wide-mode');
	await mkdir(wide, { mode: 0o700 });
	await writeFile(join(wide, 'auth-token'), 'user-token', { mode: 0o644 });
	await chmod(join(wide, 'auth-token'), 0o644);
	await expectRejectedStartup({ dataDirectory: wide }, /0600/);
	assert.equal((await stat(join(wide, 'auth-token'))).mode & 0o777, 0o644);
});

test('runtime file replacement fails closed with sanitized 500 responses and no token leakage', async (context) => {
	const { supervisor, directory } = await fixture(context);
	const database = join(directory, 'trace-store', 'traces.sqlite');
	const backup = `${database}.saved`;
	await rename(database, backup);
	try {
		await writeFile(database, `secret=${supervisor.authToken}`, { mode: 0o600 });
		const response = await api(supervisor, '/v2/traces?projectId=project');
		assert.equal(response.status, 500);
		const body = await response.text();
		assert.equal(body.includes(supervisor.authToken), false);
		assert.equal(body.includes(directory), false);
		assert.deepEqual(JSON.parse(body) as unknown, { error: { code: 'internal_error', message: 'Trace operation failed; no successful acknowledgement was issued.' } });
	} finally { await rm(database, { force: true }); await rename(backup, database); }
	assert.equal((await api(supervisor, '/v2/traces?projectId=project')).status, 200);
});