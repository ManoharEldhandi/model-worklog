import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { LOOPBACK_HOSTS } from './server';

export interface DetachedSupervisorOptions {
	readonly host: string;
	readonly port: number;
	readonly environment?: NodeJS.ProcessEnv;
}

export function supervisorEntrypointPath(): string {
	return join(__dirname, 'main.js');
}

/** Starts the packaged supervisor as a detached per-user process. */
export function launchDetachedSupervisor(options: DetachedSupervisorOptions): ChildProcess {
	if (!LOOPBACK_HOSTS.has(options.host)) {
		throw new Error(`supervisor host must be loopback, received ${options.host}`);
	}
	if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
		throw new Error(`supervisor port must be an integer between 1 and 65535, received ${options.port}`);
	}
	const child = spawn(process.execPath, [supervisorEntrypointPath()], {
		detached: true,
		stdio: 'ignore',
		windowsHide: true,
		env: { ...options.environment ?? process.env, MODEL_WORKLOG_SUPERVISOR_HOST: options.host, MODEL_WORKLOG_SUPERVISOR_PORT: String(options.port) },
	});
	child.unref();
	return child;
}