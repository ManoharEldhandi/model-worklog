import { ProjectIdSchema, type TracePrincipal } from 'model-worklog-schema';
import { canAccessTrace, TraceApiError, type TraceApi } from './traceApi';
import { PrivateWriterTokenFile, type WriterTokenStore } from './traceWriterFile';

export interface WriterReplacement {
	readonly projectId: string;
	readonly expiresAt: string | undefined;
	readonly status: 'active' | 'expired-or-revoked';
}
export interface WriterSetupOptions {
	readonly signal: AbortSignal;
	readonly store?: WriterTokenStore;
	readonly confirmReplace: (replacement: WriterReplacement) => Promise<boolean>;
}
export class WriterSetupError extends Error {
	constructor(message: string, readonly credentialToRevoke?: string) { super(message); }
}

export async function configureTraceWriter(api: TraceApi, projectId: string, options: WriterSetupOptions) {
	ProjectIdSchema.parse(projectId);
	if (!canAccessTrace(await api.identity(options.signal), projectId, 'admin')) { throw new WriterSetupError('An admin identity is required to configure SDK logging.'); }
	const store = options.store ?? new PrivateWriterTokenFile();
	const snapshot = await store.inspect();
	let previous: TracePrincipal | undefined;
	if (snapshot.existing !== undefined) {
		const token = snapshot.existing.token;
		try { previous = await api.withCredential(async () => token).identity(options.signal); }
		catch (error) {
			if (!(error instanceof TraceApiError) || error.kind !== 'unauthorized') { throw new WriterSetupError('The existing writer identity could not be checked. Nothing was replaced.'); }
		}
		if (previous !== undefined && (previous.role !== 'writer' || previous.projects.length !== 1 || previous.projects[0] !== projectId)) {
			throw new WriterSetupError('The existing credential belongs to another project or role. It was not replaced. Use a separate MODEL_WORKLOG_HOME.');
		}
		if (!await options.confirmReplace({ projectId, expiresAt: previous?.expiresAt, status: previous === undefined ? 'expired-or-revoked' : 'active' })) { return undefined; }
	}
	options.signal.throwIfAborted();
	const issued = await api.createWriter(projectId, options.signal);
	let path: string;
	try {
		options.signal.throwIfAborted();
		path = await store.write(issued.token, snapshot);
		options.signal.throwIfAborted();
	} catch {
		try { await api.revokeCredential(issued.id); }
		catch { throw new WriterSetupError('Writer setup failed and the new credential could not be revoked. Retry revocation before configuring again.', issued.id); }
		throw new WriterSetupError('Writer setup failed. The newly issued credential was revoked; no usable new credential was retained.');
	}
	let previousRevocationFailed: string | undefined;
	if (previous !== undefined) {
		try { await api.revokeCredential(previous.id); }
		catch { previousRevocationFailed = previous.id; }
	}
	return { projectId, path, id: issued.id, expiresAt: issued.expiresAt, previousRevocationFailed };
}

export function sdkQuickstart(projectId: string): string {
	ProjectIdSchema.parse(projectId);
	return `Project: ${projectId}\n\nimport { createLocalModelLogger } from 'model-worklog-sdk';\n\nconst logger = await createLocalModelLogger({\n  projectId: ${JSON.stringify(projectId)},\n  serviceName: 'my-app',\n});\n\ntry {\n  await logger.trace({ name: 'example', kind: 'workflow' }, async () => {\n    await logger.trace({ name: 'work', kind: 'custom' }, async () => {});\n  });\n} finally {\n  await logger.shutdown();\n}\n`;
}