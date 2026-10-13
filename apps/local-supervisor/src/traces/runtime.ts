import { join } from 'node:path';

import { PrivacyPolicySchema, ProjectIdSchema, type PrivacyOptions } from 'model-worklog-schema';

import { TraceApi } from './application/api';
import { TraceCredentials } from './application/credentials';
import { TraceIntake } from './application/intake';
import { traceStorageLimits } from './application/options';
import type { TraceStorageOptions } from './domain/contracts';
import { createTraceHandler, type TraceRequestHandler } from './http';
import { CryptoSecrets, SignedTraceCursors } from './infrastructure/crypto';
import { SqliteCredentialRepository } from './infrastructure/credentials';
import { TraceDatabase } from './infrastructure/database';
import { TraceFileGuard, readPrivateToken, writePrivateToken } from './infrastructure/files';
import { SqliteTraceRepository } from './infrastructure/repository';

export interface TraceRuntimeOptions {
	readonly dataDirectory: string;
	readonly adminToken: string;
	readonly now?: () => Date;
	readonly privacy?: PrivacyOptions;
	readonly storage?: TraceStorageOptions;
	readonly projectId?: string;
}

export interface TraceRuntime {
	readonly handler: TraceRequestHandler;
	close(): void;
}

function provisionWriter(directory: string, projectId: string, credentials: TraceCredentials, adminToken: string): void {
	ProjectIdSchema.parse(projectId);
	const path = join(directory, 'trace-writer-token');
	const existing = readPrivateToken(path);
	if (existing !== undefined) {
		try {
			const principal = credentials.authenticate(existing);
			if (principal.role !== 'writer' || principal.projects.length !== 1 || principal.projects[0] !== projectId) { throw new Error(); }
			return;
		} catch { throw new Error('Existing trace-writer-token is invalid, expired, revoked, or scoped differently; remove it explicitly before provisioning.'); }
	}
	const admin = credentials.authenticate(adminToken);
	const issued = credentials.create(admin, { role: 'writer', projects: [projectId] });
	try { writePrivateToken(path, issued.token); }
	catch (error) { credentials.revoke(admin, issued.id); throw error; }
}

export function openTraceRuntime(options: TraceRuntimeOptions): TraceRuntime {
	const privacy = PrivacyPolicySchema.parse(options.privacy ?? {});
	const limits = traceStorageLimits(options.storage);
	if (options.projectId !== undefined) { ProjectIdSchema.parse(options.projectId); }
	const now = options.now ?? (() => new Date());
	const database = new TraceDatabase(new TraceFileGuard(options.dataDirectory), limits);
	try {
		const secrets = new CryptoSecrets();
		const credentials = new TraceCredentials(new SqliteCredentialRepository(database, now), secrets, options.adminToken, now);
		const repository = new SqliteTraceRepository(database, limits);
		const intake = new TraceIntake(repository, secrets, privacy, now, limits.retentionTtlSeconds);
		const api = new TraceApi(credentials, intake, repository, new SignedTraceCursors(secrets.digest(options.adminToken)), now, limits.retentionTtlSeconds);
		if (options.projectId !== undefined) { provisionWriter(options.dataDirectory, options.projectId, credentials, options.adminToken); }
		return { handler: createTraceHandler(api), close: () => { database.close(); } };
	} catch (error) { database.close(); throw error; }
}