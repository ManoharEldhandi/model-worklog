import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const HOOK_FILE_NAME = 'model-worklog.json';
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'SessionEnd', 'ErrorOccurred'] as const;

export interface CopilotHookInstallOptions {
	readonly bridgePath: string;
	readonly supervisorUrl: string;
	readonly modelWorklogHome?: string;
}

function copilotHome(environment: NodeJS.ProcessEnv = process.env): string {
	return environment.COPILOT_HOME ?? join(homedir(), '.copilot');
}

export function copilotHookPath(environment: NodeJS.ProcessEnv = process.env): string {
	return join(copilotHome(environment), 'hooks', HOOK_FILE_NAME);
}

function isModelWorklogHook(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const hooks = (value as { hooks?: unknown }).hooks;
	if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
		return false;
	}
	const sessionStart = (hooks as Record<string, unknown>).SessionStart;
	if (!Array.isArray(sessionStart) || sessionStart.length === 0) {
		return false;
	}
	const entry = sessionStart[0];
	if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
		return false;
	}
	const environment = (entry as { env?: unknown }).env;
	return typeof environment === 'object' && environment !== null && !Array.isArray(environment)
		&& (environment as Record<string, unknown>).MODEL_WORKLOG_HOOK_BRIDGE === '1';
}

function hookConfig(options: CopilotHookInstallOptions): string {
	const environment = {
		MODEL_WORKLOG_HOOK_BRIDGE: '1',
		MODEL_WORKLOG_SUPERVISOR_URL: options.supervisorUrl,
		...(options.modelWorklogHome === undefined ? {} : { MODEL_WORKLOG_HOME: options.modelWorklogHome }),
	};
	const entry = { type: 'command', exec: 'node', args: [options.bridgePath], env: environment, timeoutSec: 3 };
	return `${JSON.stringify({ version: 1, hooks: Object.fromEntries(HOOK_EVENTS.map((event) => [event, [entry]])) }, null, 2)}\n`;
}

async function makePrivate(path: string, mode: number): Promise<void> {
	if (process.platform !== 'win32') {
		await chmod(path, mode);
	}
}

/** Installs only Model Logger's dedicated Copilot user hook; foreign files are never overwritten. */
export async function installCopilotHook(options: CopilotHookInstallOptions, environment: NodeJS.ProcessEnv = process.env): Promise<string> {
	const destination = copilotHookPath(environment);
	const directory = join(copilotHome(environment), 'hooks');
	await mkdir(directory, { recursive: true, mode: 0o700 });
	await makePrivate(directory, 0o700);
	try {
		const existing = JSON.parse(await readFile(destination, 'utf8')) as unknown;
		if (!isModelWorklogHook(existing)) {
			throw new Error(`Refusing to replace a non-Model Logger Copilot hook at ${destination}.`);
		}
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
	const temporary = `${destination}.tmp`;
	await writeFile(temporary, hookConfig(options), { encoding: 'utf8', mode: 0o600 });
	await rename(temporary, destination);
	await makePrivate(destination, 0o600);
	return destination;
}

/** Removes only a hook file that is positively identified as Model Logger-owned. */
export async function removeCopilotHook(environment: NodeJS.ProcessEnv = process.env): Promise<void> {
	const destination = copilotHookPath(environment);
	try {
		if (!isModelWorklogHook(JSON.parse(await readFile(destination, 'utf8')) as unknown)) {
			return;
		}
		await unlink(destination);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
}