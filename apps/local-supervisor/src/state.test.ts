import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { AUTH_TOKEN_FILE, createOrLoadAuthToken, tokensMatch } from './state';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), 'model-worklog-state-'));
	temporaryDirectories.push(directory);
	return directory;
}

after(async () => {
	await Promise.all(temporaryDirectories.map((directory) => rm(directory, { recursive: true, force: true })));
});

test('creates and preserves a stable local authentication token', async () => {
	const dataDirectory = join(await temporaryDirectory(), 'store');
	const first = await createOrLoadAuthToken(dataDirectory);
	const second = await createOrLoadAuthToken(dataDirectory);
	assert.equal(first, second);
	assert.equal(first.length, 43);
});

test('hardens pre-existing store permissions on POSIX platforms', async (context) => {
	if (process.platform === 'win32') {
		context.skip('POSIX modes are not available on Windows');
		return;
	}
	const dataDirectory = join(await temporaryDirectory(), 'store');
	await createOrLoadAuthToken(dataDirectory);
	await chmod(dataDirectory, 0o755);
	await chmod(join(dataDirectory, AUTH_TOKEN_FILE), 0o644);

	await createOrLoadAuthToken(dataDirectory);

	assert.equal((await stat(dataDirectory)).mode & 0o777, 0o700);
	assert.equal((await stat(join(dataDirectory, AUTH_TOKEN_FILE))).mode & 0o777, 0o600);
});

test('compares tokens without accepting a prefix or a missing value', () => {
	assert.equal(tokensMatch('abcdefgh', 'abcdefgh'), true);
	assert.equal(tokensMatch('abcdefgh', 'abcdefg'), false);
	assert.equal(tokensMatch('abcdefgh', undefined), false);
});
