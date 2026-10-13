import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { HttpTraceExporter, type HttpTraceExporterOptions } from './http';
import { createModelLogger, type ModelLogger } from './logger';
import type { ModelLoggerOptions } from './types';

export interface LocalModelLoggerOptions extends Omit<ModelLoggerOptions, 'exporter'>, Omit<HttpTraceExporterOptions, 'token'> {
	readonly token?: string;
	readonly environment?: NodeJS.ProcessEnv;
}

async function writerToken(environment: NodeJS.ProcessEnv): Promise<string> {
	const directory = environment.MODEL_WORKLOG_HOME ?? join(homedir(), '.model-worklog');
	const handle = await open(join(directory, 'trace-writer-token'), constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size > 4_096 || (metadata.mode & 0o077) !== 0) {
			throw new Error('Trace writer token must be a private regular file of at most 4096 bytes.');
		}
		return (await handle.readFile('utf8')).trim();
	} finally { await handle.close(); }
}

export async function createLocalModelLogger(options: LocalModelLoggerOptions): Promise<ModelLogger> {
	const environment = options.environment ?? process.env;
	return createModelLogger({
		...options,
		exporter: new HttpTraceExporter({
			token: options.token ?? await writerToken(environment),
			endpoint: options.endpoint ?? environment.MODEL_WORKLOG_TRACE_ENDPOINT ?? environment.MODEL_WORKLOG_SUPERVISOR_URL,
			timeoutMs: options.timeoutMs, fetchImpl: options.fetchImpl,
		}),
	});
}