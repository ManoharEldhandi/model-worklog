#!/usr/bin/env node
import { LOOPBACK_HOSTS, startSupervisor } from './server';
import { DEFAULT_SUPERVISOR_PORT, SUPERVISOR_VERSION } from './version';

function resolvePort(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === '') {
		return DEFAULT_SUPERVISOR_PORT;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
		throw new Error(`invalid MODEL_WORKLOG_SUPERVISOR_PORT: ${raw}`);
	}
	return parsed;
}

function resolveHost(raw: string | undefined): string {
	const host = raw ?? '127.0.0.1';
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(`invalid MODEL_WORKLOG_SUPERVISOR_HOST: ${host}`);
	}
	return host;
}

async function main(): Promise<void> {
	const port = resolvePort(process.env.MODEL_WORKLOG_SUPERVISOR_PORT);
	const running = await startSupervisor({
		version: SUPERVISOR_VERSION,
		host: resolveHost(process.env.MODEL_WORKLOG_SUPERVISOR_HOST),
		port,
		shutdownWhenNoExtensionClients: process.env.MODEL_WORKLOG_SHUTDOWN_WHEN_IDLE === '1',
	});
	process.stderr.write(`model-worklog supervisor ${SUPERVISOR_VERSION} listening on ${running.url} (instance ${running.instanceId})\n`);

	let closing = false;
	const shutdown = (): void => {
		if (closing) {
			return;
		}
		closing = true;
		running
			.close()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`supervisor failed to start: ${message}\n`);
	process.exit(1);
});
