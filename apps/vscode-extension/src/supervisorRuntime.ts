import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';

import { probeSupervisor, type SupervisorConnection } from './supervisorClient';

const STARTUP_TIMEOUT_MS = 8_000;
const RETRY_INTERVAL_MS = 100;

export interface SupervisorProcess {
	readonly exitCode: number | null;
	once(event: 'exit' | 'error', listener: (...argumentsValue: unknown[]) => void): unknown;
	unref(): void;
}

export type SpawnSupervisor = (command: string, argumentsValue: readonly string[], options: {
	readonly env: NodeJS.ProcessEnv;
	readonly detached: boolean;
	readonly stdio: 'ignore';
	readonly windowsHide: boolean;
}) => SupervisorProcess;

export interface SupervisorRuntimeOptions {
	readonly extensionPath: string;
	readonly spawnSupervisor?: SpawnSupervisor;
	readonly probe?: (url: URL) => Promise<SupervisorConnection>;
	readonly now?: () => number;
}

function isLoopbackTarget(url: URL): boolean {
	return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(url.hostname.replace(/^\[(.+)\]$/, '$1'));
}

export function bundledSupervisorPath(extensionPath: string): string {
	return join(extensionPath, 'dist', 'supervisor.js');
}

export function supervisorEnvironment(url: URL, environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	if (!isLoopbackTarget(url)) {
		throw new Error('The bundled supervisor may start only on a loopback HTTP URL.');
	}
	const port = url.port === '' ? '80' : url.port;
	if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
		throw new Error(`Invalid supervisor port: ${port}`);
	}
	return { ...environment, ELECTRON_RUN_AS_NODE: '1', MODEL_WORKLOG_SUPERVISOR_PORT: port };
}

/**
 * Owns only the extension's spawned-process handle. The local supervisor is
 * deliberately detached so an extension reload cannot discard durable evidence.
 */
export class SupervisorRuntime {
	private readonly spawnSupervisor: SpawnSupervisor;
	private readonly probe: (url: URL) => Promise<SupervisorConnection>;
	private readonly now: () => number;
	private child: SupervisorProcess | undefined;
	private startupFailure: string | undefined;

	constructor(private readonly options: SupervisorRuntimeOptions) {
		this.spawnSupervisor = options.spawnSupervisor ?? ((command, argumentsValue, spawnOptions) => spawn(command, argumentsValue, spawnOptions));
		this.probe = options.probe ?? probeSupervisor;
		this.now = options.now ?? Date.now;
	}

	async ensureRunning(url: URL): Promise<SupervisorConnection> {
		const existing = await this.probe(url);
		if (existing.kind !== 'unreachable') {
			return existing;
		}
		if (this.child === undefined || this.child.exitCode !== null) {
			this.startupFailure = undefined;
			this.child = this.spawnSupervisor(process.execPath, [bundledSupervisorPath(this.options.extensionPath)], {
				env: supervisorEnvironment(url), detached: true, stdio: 'ignore', windowsHide: true,
			});
			this.child.once('error', (error) => {
				this.startupFailure = error instanceof Error ? error.message : String(error);
			});
			this.child.once('exit', (code) => {
				if (code !== 0 && this.startupFailure === undefined) {
					this.startupFailure = `exit ${String(code)}`;
				}
			});
			this.child.unref();
		}
		const deadline = this.now() + STARTUP_TIMEOUT_MS;
		for (;;) {
			const connection = await this.probe(url);
			if (connection.kind !== 'unreachable') {
				return connection;
			}
			if (this.now() >= deadline) {
				throw new Error(`The bundled supervisor did not become healthy before the startup timeout${this.startupFailure === undefined ? '.' : ` (${this.startupFailure}).`}`);
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
		}
	}
}