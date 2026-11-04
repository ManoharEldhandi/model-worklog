import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveAgentCli, spawnAgentCli } from './executables';

test('CLI discovery honors explicit paths and PATH before GUI fallbacks', () => {
	const canExecute = (path: string): boolean => ['/custom/bin/codex', '/opt/homebrew/bin/codex', '/custom Copilot/copilot'].includes(path);
	const configured = resolveAgentCli('copilot', { environment: { MODEL_WORKLOG_COPILOT_PATH: '/custom Copilot/copilot', PATH: '/custom/bin' }, platform: 'darwin', canExecute, loginPath: () => '/opt/homebrew/bin' });
	assert.equal(configured.command, '/custom Copilot/copilot');
	assert.equal(resolveAgentCli('codex', { environment: { PATH: '/custom/bin' }, platform: 'darwin', canExecute }).command, '/custom/bin/codex');
	assert.equal(resolveAgentCli('codex', { environment: { PATH: '/usr/bin:/bin' }, platform: 'darwin', canExecute, loginPath: () => '' }).command, '/opt/homebrew/bin/codex');
	assert.throws(() => resolveAgentCli('codex', { environment: { MODEL_WORKLOG_CODEX_PATH: '/missing/codex' }, canExecute: () => false }), /MODEL_WORKLOG_CODEX_PATH/);
});

test('login-shell paths retain the Node runtime required by CLI shebangs', () => {
	const result = resolveAgentCli('copilot', { environment: { PATH: '/usr/bin:/bin' }, platform: 'darwin', home: '/home/app',
		canExecute: (path) => path === '/versions/node/v22/bin/copilot', loginPath: () => '/versions/node/v22/bin:/usr/bin' });
	assert.equal(result.command, '/versions/node/v22/bin/copilot');
	assert.match(result.environment.PATH!, /\/versions\/node\/v22\/bin/);
});

test('Windows PATH casing, PATHEXT and native CLI installations are recognized', () => {
	const result = resolveAgentCli('codex', { environment: { Path: 'C:\\Tools;C:\\Windows', PATHEXT: '.EXE;.CMD' }, platform: 'win32',
		canExecute: (path) => path === 'C:\\Tools\\codex.exe', loginPath: () => '' });
	assert.equal(result.command, 'C:\\Tools\\codex.exe');
});

test('a custom CLI with spaces starts without shell interpolation or Electron flags', { skip: process.platform === 'win32' }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'logger cli ')); const path = join(directory, 'copilot custom');
	try {
		await writeFile(path, '#!/bin/sh\nprintf "%s\\n" "$1" "${ELECTRON_RUN_AS_NODE-unset}"\n', { mode: 0o700 });
		const child = spawnAgentCli('copilot', ['literal $(echo should-not-execute)'], { env: { ...process.env, MODEL_WORKLOG_COPILOT_PATH: path, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'pipe' });
		let output = ''; child.stdout!.on('data', (data: Buffer) => { output += String(data); });
		assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }), 0);
		assert.equal(output, 'literal $(echo should-not-execute)\nunset\n');
	} finally { await rm(directory, { recursive: true, force: true }); }
});

test('npm CLI scripts work when a GUI PATH cannot locate their Node shebang runtime', { skip: process.platform === 'win32' }, async () => {
	const directory = await mkdtemp(join(tmpdir(), 'logger node cli ')); const path = join(directory, 'copilot');
	try {
		await writeFile(path, '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2)));\n', { mode: 0o700 });
		const child = spawnAgentCli('copilot', ['a path with spaces', 'literal;not-a-command'], { env: { PATH: '/usr/bin:/bin', MODEL_WORKLOG_COPILOT_PATH: path, MODEL_WORKLOG_NODE_PATH: process.execPath }, stdio: 'pipe' });
		let output = ''; child.stdout!.on('data', (data: Buffer) => { output += String(data); });
		assert.equal(await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }), 0);
		assert.deepEqual(JSON.parse(output), ['a path with spaces', 'literal;not-a-command']);
	} finally { await rm(directory, { recursive: true, force: true }); }
});
