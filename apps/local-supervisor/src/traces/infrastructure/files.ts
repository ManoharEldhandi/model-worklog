import { constants, lstatSync, mkdirSync, openSync, closeSync, fstatSync, readFileSync, writeFileSync, fsyncSync, type Stats } from 'node:fs';
import { join } from 'node:path';

function missing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function owned(metadata: Stats): boolean {
	return typeof process.getuid !== 'function' || metadata.uid === process.getuid();
}

function privateDirectory(path: string): Stats {
	try { mkdirSync(path, { recursive: true, mode: 0o700 }); } catch (error) {
		if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) { throw error; }
	}
	const metadata = lstatSync(path);
	if (!metadata.isDirectory() || !owned(metadata) || (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o700)) {
		throw new Error('Trace storage requires an owned, private 0700 directory, not a symlink.');
	}
	return metadata;
}

export function checkPrivateFile(path: string): Stats | undefined {
	let metadata: Stats;
	try { metadata = lstatSync(path); } catch (error) {
		if (missing(error)) { return undefined; }
		throw error;
	}
	if (!metadata.isFile() || metadata.nlink !== 1 || !owned(metadata) || (process.platform !== 'win32' && (metadata.mode & 0o777) !== 0o600)) {
		throw new Error('Trace storage and credential files must be owned private 0600 regular files, without links.');
	}
	return metadata;
}

export function readPrivateToken(path: string): string | undefined {
	const expected = checkPrivateFile(path);
	if (expected === undefined) { return undefined; }
	const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const metadata = fstatSync(descriptor);
		if (metadata.ino !== expected.ino || metadata.dev !== expected.dev || metadata.size > 4_096) {
			throw new Error('Credential file changed or exceeds 4096 bytes.');
		}
		const token = readFileSync(descriptor, 'utf8').trim();
		if (token === '' || /[\s\x00-\x1f\x7f]/.test(token)) { throw new Error('Credential file contains an invalid token.'); }
		return token;
	} finally { closeSync(descriptor); }
}

export function writePrivateToken(path: string, token: string): void {
	const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
	try { writeFileSync(descriptor, `${token}\n`, 'utf8'); fsyncSync(descriptor); }
	finally { closeSync(descriptor); }
}

export function prepareTraceDirectory(dataDirectory: string): void {
	privateDirectory(dataDirectory);
	for (const filename of ['auth-token', 'trace-writer-token', 'supervisor.lock', 'trusted-workspaces.json']) {
		checkPrivateFile(join(dataDirectory, filename));
	}
	readPrivateToken(join(dataDirectory, 'auth-token'));
}

export class TraceFileGuard {
	readonly databasePath: string;
	private readonly directories: readonly { path: string; metadata: Stats }[];
	private readonly identities = new Map<string, Stats>();
	private readonly files: readonly string[];

	constructor(dataDirectory: string) {
		const root = privateDirectory(dataDirectory);
		const directory = join(dataDirectory, 'trace-store');
		const store = privateDirectory(directory);
		this.directories = [{ path: dataDirectory, metadata: root }, { path: directory, metadata: store }];
		this.databasePath = join(directory, 'traces.sqlite');
		this.files = ['', '-wal', '-shm', '-journal'].map((suffix) => `${this.databasePath}${suffix}`);
		this.check();
		if (checkPrivateFile(this.databasePath) === undefined) {
			const descriptor = openSync(this.databasePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
			closeSync(descriptor);
		}
		this.check();
	}

	check(): void {
		for (const { path, metadata } of this.directories) {
			const current = lstatSync(path);
			if (!current.isDirectory() || current.ino !== metadata.ino || current.dev !== metadata.dev || !owned(current)
				|| (process.platform !== 'win32' && (current.mode & 0o777) !== 0o700)) {
				throw new Error('Trace storage directory changed or is not private.');
			}
		}
		for (const path of this.files) {
			const current = checkPrivateFile(path);
			const previous = this.identities.get(path);
			if (previous !== undefined && (current === undefined || current.ino !== previous.ino || current.dev !== previous.dev)) {
				throw new Error('Trace storage file identity changed.');
			}
			if (current !== undefined) { this.identities.set(path, current); }
		}
	}
}