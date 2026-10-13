import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, rename, unlink, type FileHandle } from 'node:fs/promises';
import { join, parse, relative, sep } from 'node:path';

export const spoolFilename = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;
const temporaryFilename = /^\.[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/;

export async function privateDirectory(directory: string, create = false): Promise<Stats> {
	let current = parse(directory).root;
	for (const component of relative(current, directory).split(sep).filter(Boolean)) {
		current = join(current, component);
		let metadata: Stats;
		try { metadata = await lstat(current); }
		catch (error) {
			if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; }
			try { await mkdir(current, { mode: 0o700 }); }
			catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') { throw failure; } }
			metadata = await lstat(current);
		}
		if (metadata.isSymbolicLink() || !metadata.isDirectory()) { throw new Error('Unsafe spool directory.'); }
	}
	const metadata = await lstat(directory);
	if ((metadata.mode & 0o077) !== 0 || (process.getuid !== undefined && metadata.uid !== process.getuid())) {
		throw new Error('Spool directory must be private and owned by this user.');
	}
	return metadata;
}

export async function privateFile(path: string, maxBytes: number): Promise<FileHandle> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077) !== 0 || metadata.size > maxBytes
			|| (process.getuid !== undefined && metadata.uid !== process.getuid())) { throw new Error('Unsafe spool file.'); }
		return handle;
	} catch (error) { await handle.close(); throw error; }
}

export async function* spoolFiles(directory: string): AsyncGenerator<{ name: string; temporary: boolean }> {
	const entries = await opendir(directory);
	for await (const entry of entries) {
		if (entry.isSymbolicLink()) { throw new Error('Spool symlinks are forbidden.'); }
		if (spoolFilename.test(entry.name) || temporaryFilename.test(entry.name)) {
			if (!entry.isFile()) { throw new Error('Spool entries must be regular files.'); }
			yield { name: entry.name, temporary: temporaryFilename.test(entry.name) };
		}
	}
}

export async function readBounded(path: string, maxBytes: number): Promise<string> {
	const handle = await privateFile(path, maxBytes);
	try {
		const buffer = Buffer.alloc(maxBytes + 1);
		let total = 0;
		while (total <= maxBytes) {
			const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
			if (bytesRead === 0) { return buffer.subarray(0, total).toString('utf8'); }
			total += bytesRead;
		}
		throw new Error('Spool entry exceeds its size limit.');
	} finally { await handle.close(); }
}

export async function syncDirectory(directory: string): Promise<void> {
	const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
	try { await handle.sync(); } finally { await handle.close(); }
}

export async function atomicWrite(directory: string, id: string, content: string): Promise<void> {
	const temporary = join(directory, `.${id.slice(0, -5)}.tmp`);
	const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
	let committed = false;
	try {
		try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
		finally { await handle.close(); }
		await rename(temporary, join(directory, id));
		committed = true;
		await syncDirectory(directory);
	} finally {
		if (!committed) { await unlink(temporary).catch(() => undefined); }
	}
}