import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
function run(python) {
	const child = spawn(process.execPath, ['scripts/run-rag.mjs', '--no-chat'], { cwd: root, env: { ...process.env, MODEL_WORKLOG_RAG_PYTHON: python }, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
	return { child, completed: new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code) => resolve({ code, output })); }) };
}
async function freePort() { const server = createServer(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); const port = server.address().port; await new Promise((resolve) => server.close(resolve)); return port; }
async function listening(port) { return new Promise((resolve) => { const socket = connect(port, '127.0.0.1'); socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false)); }); }

test('a missing service executable fails promptly and cleans up the demo', { timeout: 10_000 }, async () => {
	const result = await run(resolve(tmpdir(), 'missing-rag-python', 'python')).completed;
	assert.equal(result.code, 1); assert.match(result.output, /Could not start/); assert.match(result.output, /temporary log data removed/);
});

test('interrupting model startup stops only the spawned services and releases their socket', { timeout: 10_000 }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'rag-launcher-stop-'));
	const python = join(directory, 'fake-python'); const port = await freePort();
	// A deliberately unready service exercises Ctrl+C during model startup without model downloads.
	await writeFile(python, `#!${process.execPath}\nconst http = require('node:http'); if (process.argv.includes('--cache-dir')) { http.createServer((_q, r) => { r.statusCode = 503; r.end(); }).listen(${port}, '127.0.0.1'); } else { setInterval(() => {}, 1000); }\n`, { mode: 0o700 });
	const { child, completed } = run(python);
	try {
		for (let count = 0; count < 100 && !await listening(port); count++) { await new Promise((resolve) => setTimeout(resolve, 30)); }
		assert.equal(await listening(port), true, 'The test service must start before interruption.');
		child.kill('SIGTERM'); const result = await completed;
		assert.equal(result.code, 130); assert.match(result.output, /Demo stopped/);
		assert.equal(await listening(port), false, 'The launcher must not leave a service running.');
	} finally { child.kill('SIGKILL'); await rm(directory, { recursive: true, force: true }); }
});
