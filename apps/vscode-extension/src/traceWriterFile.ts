import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

export interface WriterFileSnapshot {
	readonly directory: string;
	readonly path: string;
	readonly directoryStat: Stats;
	readonly existing: { readonly token: string; readonly stat: Stats } | undefined;
}
export interface WriterTokenStore {
	inspect(): Promise<WriterFileSnapshot>;
	write(token: string, expected: WriterFileSnapshot): Promise<string>;
}

function absent(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
function owned(stat: Stats): boolean { return process.getuid === undefined || stat.uid === process.getuid(); }
function sameFile(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function privateFile(stat: Stats): void {
	if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600 || stat.size > 4_096 || !owned(stat)) {
		throw new Error('The writer token must be an owned 0600 regular file without symlinks or hardlinks.');
	}
}

export class PrivateWriterTokenFile implements WriterTokenStore {
	private readonly directory: string;
	constructor(environment: NodeJS.ProcessEnv = process.env) {
		this.directory = environment.MODEL_WORKLOG_HOME ?? join(homedir(), '.model-worklog');
		if (!isAbsolute(this.directory)) { throw new Error('MODEL_WORKLOG_HOME must be an absolute private directory.'); }
	}

	async inspect(): Promise<WriterFileSnapshot> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const directoryStat = await this.checkDirectory();
		const directory = await realpath(this.directory);
		const path = join(directory, 'trace-writer-token');
		let before: Stats;
		try { before = await lstat(path); }
		catch (error) { if (absent(error)) { return { directory, directoryStat, path, existing: undefined }; } throw error; }
		privateFile(before);
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await handle.stat();
			privateFile(stat);
			if (!sameFile(before, stat)) { throw new Error('The writer token changed while it was being inspected.'); }
			const token = (await handle.readFile('utf8')).trim();
			if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) { throw new Error('The existing writer token is malformed; remove it explicitly before retrying.'); }
			if (!sameFile(stat, await lstat(path))) { throw new Error('The writer token changed while it was being inspected.'); }
			return { directory, directoryStat, path, existing: { token, stat } };
		} finally { await handle.close(); }
	}

	async write(token: string, expected: WriterFileSnapshot): Promise<string> {
		if (!/^[a-zA-Z0-9_-]{43}$/.test(token)) { throw new Error('Invalid writer credential.'); }
		await this.verifyExpected(expected);
		const temporary = join(expected.directory, `.trace-writer-${randomUUID()}`);
		const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
		try {
			try {
				privateFile(await handle.stat());
				await handle.writeFile(`${token}\n`, 'utf8');
				await handle.sync();
			} finally { await handle.close(); }
			await this.verifyExpected(expected);
			if (expected.existing === undefined) { await link(temporary, expected.path); }
			else { await rename(temporary, expected.path); }
			return expected.path;
		} finally {
			await unlink(temporary).catch((error: unknown) => { if (!absent(error)) { throw error; } });
		}
	}

	private async checkDirectory(): Promise<Stats> {
		const stat = await lstat(this.directory);
		if (!stat.isDirectory() || stat.isSymbolicLink() || !owned(stat) || (stat.mode & 0o077) !== 0) {
			throw new Error('MODEL_WORKLOG_HOME must be an owned private directory, not a symlink.');
		}
		return stat;
	}

	private async verifyExpected(expected: WriterFileSnapshot): Promise<void> {
		const directoryStat = await this.checkDirectory();
		if (directoryStat.dev !== expected.directoryStat.dev || directoryStat.ino !== expected.directoryStat.ino || await realpath(this.directory) !== expected.directory) {
			throw new Error('The credential directory changed. Run Configure SDK Logging again.');
		}
		let current: Stats;
		try { current = await lstat(expected.path); }
		catch (error) { if (absent(error) && expected.existing === undefined) { return; } throw error; }
		privateFile(current);
		if (expected.existing === undefined || !sameFile(current, expected.existing.stat)) {
			throw new Error('The writer token changed after confirmation. Run Configure SDK Logging again.');
		}
	}
}