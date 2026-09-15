import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const AUTH_TOKEN_FILE = 'auth-token';
export const TRUSTED_WORKSPACES_FILE = 'trusted-workspaces.json';
export const STORE_LOCK_FILE = 'supervisor.lock';

export interface TrustedWorkspace {
	readonly fingerprint: string;
	readonly label: string;
	readonly trustedAt: string;
}

export interface StoreLock {
	close(): Promise<void>;
}

interface StoredLockOwner {
	readonly pid?: unknown;
}

export function defaultDataDirectory(): string {
	return process.env.MODEL_WORKLOG_HOME ?? join(homedir(), '.model-worklog');
}

async function ensurePrivateDirectory(dataDirectory: string): Promise<void> {
	await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
	const metadata = await lstat(dataDirectory);
	if (!metadata.isDirectory()) {
		throw new Error(`local evidence store must be a directory: ${dataDirectory}`);
	}
	// Windows ACLs are not represented by POSIX mode bits. On POSIX, correct
	// inherited or pre-existing broad permissions before storing credentials.
	if (process.platform !== 'win32') {
		await chmod(dataDirectory, 0o700);
	}
}

async function ensurePrivateFile(path: string, description: string): Promise<void> {
	const metadata = await lstat(path);
	if (!metadata.isFile()) {
		throw new Error(`${description} must be a regular file: ${path}`);
	}
	if (process.platform !== 'win32') {
		await chmod(path, 0o600);
	}
}

async function hasDefinitelyInactiveLockOwner(path: string): Promise<boolean> {
	let owner: StoredLockOwner;
	try {
		owner = JSON.parse(await readFile(path, 'utf8')) as StoredLockOwner;
	} catch {
		return false;
	}
	if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || owner.pid < 1) {
		return true;
	}
	try {
		process.kill(owner.pid, 0);
		return false;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ESRCH';
	}
}

/**
 * Claims exclusive ownership of a local evidence directory. A stale lock is
 * intentionally not deleted automatically: safe stale-lock recovery requires
 * an operating-system-level lock or an identity comparison primitive.
 */
export async function acquireExclusiveStoreLock(dataDirectory: string, instanceId: string): Promise<StoreLock> {
	await ensurePrivateDirectory(dataDirectory);
	const destination = join(dataDirectory, STORE_LOCK_FILE);
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(destination, 'wx', 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
			throw error;
		}
		if (!await hasDefinitelyInactiveLockOwner(destination)) {
			throw new Error(`another supervisor already owns ${dataDirectory}; stop it before starting another instance`);
		}
		await unlink(destination);
		try {
			handle = await open(destination, 'wx', 0o600);
		} catch (retryError) {
			if ((retryError as NodeJS.ErrnoException).code === 'EEXIST') {
				throw new Error(`another supervisor started while recovering ${dataDirectory}; retry after it stops`);
			}
			throw retryError;
		}
	}
	try {
		await handle.writeFile(`${JSON.stringify({ instanceId, pid: process.pid, startedAt: new Date().toISOString() })}\n`, 'utf8');
	} catch (error) {
		await handle.close();
		await unlink(destination).catch(() => undefined);
		throw error;
	}
	let released = false;
	return {
		close: async (): Promise<void> => {
			if (released) {
				return;
			}
			released = true;
			await handle.close();
			await unlink(destination).catch((error: unknown) => {
				if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
					throw error;
				}
			});
		},
	};
}

export async function createOrLoadAuthToken(dataDirectory: string, suppliedToken?: string): Promise<string> {
	if (suppliedToken !== undefined) {
		return suppliedToken;
	}
	await ensurePrivateDirectory(dataDirectory);
	const destination = join(dataDirectory, AUTH_TOKEN_FILE);
	try {
		await ensurePrivateFile(destination, 'local authentication token');
		const existing = (await readFile(destination, 'utf8')).trim();
		if (existing !== '') {
			return existing;
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}

	const generated = randomBytes(32).toString('base64url');
	const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
	await writeFile(temporary, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, destination);
	return generated;
}

export function tokensMatch(expected: string, provided: string | undefined): boolean {
	if (provided === undefined) {
		return false;
	}
	const expectedBytes = Buffer.from(expected);
	const providedBytes = Buffer.from(provided);
	return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

export async function readTrustedWorkspaces(dataDirectory: string): Promise<readonly TrustedWorkspace[]> {
	try {
		const raw = await readFile(join(dataDirectory, TRUSTED_WORKSPACES_FILE), 'utf8');
		const value: unknown = JSON.parse(raw);
		if (!Array.isArray(value)) {
			throw new Error('trusted workspace registry is not an array');
		}
		return value.map((entry): TrustedWorkspace => {
			if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
				throw new Error('trusted workspace registry contains a malformed entry');
			}
			const candidate = entry as Partial<TrustedWorkspace>;
			if (typeof candidate.fingerprint !== 'string' || typeof candidate.label !== 'string' || typeof candidate.trustedAt !== 'string') {
				throw new Error('trusted workspace registry contains an incomplete entry');
			}
			return { fingerprint: candidate.fingerprint, label: candidate.label, trustedAt: candidate.trustedAt };
		});
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return [];
		}
		throw error;
	}
}

export async function writeTrustedWorkspaces(dataDirectory: string, workspaces: readonly TrustedWorkspace[]): Promise<void> {
	await ensurePrivateDirectory(dataDirectory);
	const destination = join(dataDirectory, TRUSTED_WORKSPACES_FILE);
	const temporary = `${destination}.${randomBytes(8).toString('hex')}.tmp`;
	await writeFile(temporary, `${JSON.stringify(workspaces)}\n`, { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, destination);
}
