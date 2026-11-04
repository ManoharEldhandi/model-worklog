import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { accessSync, closeSync, constants, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

export type AgentCli = 'codex' | 'copilot';
export interface AgentCliResolutionOptions {
	readonly environment?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform; readonly home?: string;
	readonly canExecute?: (path: string) => boolean; readonly loginPath?: () => string;
}
const shellPaths = new Map<string, string>();
function executable(path: string): boolean { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } }
function pathValue(environment: NodeJS.ProcessEnv): string { return Object.entries(environment).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''; }
function loginShellPath(environment: NodeJS.ProcessEnv, home: string): string {
	const shell = environment.SHELL;
	if (!shell || !posix.isAbsolute(shell) || !executable(shell)) { return ''; }
	const key = JSON.stringify([shell, home, pathValue(environment)]); const cached = shellPaths.get(key); if (cached !== undefined) { return cached; }
	let value = '';
	try {
		// Constant command, bounded output/time, and the user's home rather than a workspace.
		const output = execFileSync(shell, ['-ilc', 'printf "\\n__MODEL_WORKLOG_PATH__%s\\n" "$PATH"'], { cwd: home, env: { ...environment, ELECTRON_RUN_AS_NODE: undefined }, timeout: 2000, maxBuffer: 65536, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
		value = /(?:^|\n)__MODEL_WORKLOG_PATH__([^\n]*)/.exec(output)?.[1] ?? '';
	} catch { /* Explicit configuration and known install locations still work. */ }
	shellPaths.set(key, value); return value;
}

/** Resolve CLI installations without depending on the GUI application's PATH. */
export function resolveAgentCli(tool: AgentCli, options: AgentCliResolutionOptions = {}): { command: string; environment: NodeJS.ProcessEnv } {
	const environment = { ...(options.environment ?? process.env) }; const platform = options.platform ?? process.platform;
	const paths = platform === 'win32' ? win32 : posix; const delimiter = platform === 'win32' ? ';' : ':';
	const home = options.home ?? environment.HOME ?? environment.USERPROFILE ?? homedir(); const canExecute = options.canExecute ?? executable;
	const variable = tool === 'codex' ? 'MODEL_WORKLOG_CODEX_PATH' : 'MODEL_WORKLOG_COPILOT_PATH';
	const explicit = environment[variable]?.trim();
	const configured = explicit?.replace(/^~(?=[/\\])/, home);
	const directories = pathValue(environment).split(delimiter).filter((path) => paths.isAbsolute(path));
	const common = platform === 'win32' ? [environment.APPDATA && paths.join(environment.APPDATA, 'npm'), environment.LOCALAPPDATA && paths.join(environment.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'), environment.VOLTA_HOME && paths.join(environment.VOLTA_HOME, 'bin')]
		: [platform === 'darwin' ? '/opt/homebrew/bin' : undefined, '/usr/local/bin', paths.join(home, '.local', 'bin'), paths.join(home, '.npm-global', 'bin'), paths.join(home, '.volta', 'bin'), paths.join(home, '.asdf', 'shims'), paths.join(home, '.local', 'share', 'mise', 'shims'), environment.NVM_BIN];
	directories.push(...common.filter((path): path is string => !!path && paths.isAbsolute(path)));
	const windowsExtensions = (environment.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((value) => value.toLowerCase()).filter((value) => ['.exe', '.cmd', '.bat', '.com'].includes(value));
	const extensions = platform === 'win32' ? [...new Set([...windowsExtensions, '.exe', '.cmd', ''])] : [''];
	const find = (): string | undefined => directories.flatMap((directory) => extensions.map((extension) => paths.join(directory, tool + extension))).find(canExecute);
	let command: string | undefined;
	if (configured) {
		if (!paths.isAbsolute(configured) || !canExecute(configured)) { throw new Error(`The configured ${tool} executable is unavailable. Check model-worklog.${tool}.path or ${variable}; use the full executable path without arguments.`); }
		command = configured;
	} else { command = find(); }
	// Preserve the selected version manager's Node executable along with its CLI.
	if (command === undefined || (configured && platform !== 'win32')) {
		const login = options.loginPath?.() ?? (platform === 'win32' ? '' : loginShellPath(environment, home));
		directories.push(...login.split(delimiter).filter((path) => paths.isAbsolute(path))); command ??= find();
	}
	if (command === undefined) { throw new Error(`${tool} was not found. Install its CLI or set model-worklog.${tool}.path in VS Code / ${variable} to its full executable path.`); }
	for (const key of Object.keys(environment)) { if (key.toLowerCase() === 'path') { delete environment[key]; } }
	environment.PATH = [...new Set([paths.dirname(command), ...directories])].join(delimiter);
	delete environment.ELECTRON_RUN_AS_NODE;
	return { command, environment };
}

function nodeScript(command: string, tool: AgentCli): string | undefined {
	if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
		const packageRoot = win32.join(win32.dirname(command), 'node_modules', tool === 'codex' ? '@openai/codex' : '@github/copilot');
		try {
			const manifest = win32.join(packageRoot, 'package.json'); if (statSync(manifest).size > 65536) { throw new Error(); }
			const value = JSON.parse(readFileSync(manifest, 'utf8')) as { bin?: string | Record<string, string> };
			const bin = typeof value.bin === 'string' ? value.bin : value.bin?.[tool];
			if (typeof bin !== 'string' || win32.isAbsolute(bin) || bin.split(/[\\/]/).includes('..')) { throw new Error(); }
			const script = win32.join(packageRoot, bin); if (!statSync(script).isFile()) { throw new Error(); } return script;
		} catch { throw new Error(`The ${tool} command shim has no usable npm entry point. Set MODEL_WORKLOG_${tool.toUpperCase()}_PATH to the installed native executable or reinstall its npm package.`); }
	}
	let descriptor: number | undefined;
	try {
		const target = realpathSync(command); descriptor = openSync(target, 'r'); const bytes = Buffer.alloc(256); const length = readSync(descriptor, bytes, 0, bytes.length, 0);
		return /^#![^\n]*\bnode(?:\s|$)/.test(bytes.subarray(0, length).toString()) ? target : undefined;
	} catch { return undefined; } finally { if (descriptor !== undefined) { closeSync(descriptor); } }
}

/** Node CLI shims run through a runtime directly; prompts never go through a shell. */
export function spawnAgentCli(tool: AgentCli, args: readonly string[], options: SpawnOptions = {}): ChildProcess {
	const launch = resolveAgentCli(tool, { environment: options.env }); const script = nodeScript(launch.command, tool);
	let command = launch.command; let argumentsValue = [...args];
	if (script !== undefined) {
		const paths = process.platform === 'win32' ? win32 : posix;
		const explicitNode = launch.environment.MODEL_WORKLOG_NODE_PATH;
		if (explicitNode && (!paths.isAbsolute(explicitNode) || !executable(explicitNode))) { throw new Error('MODEL_WORKLOG_NODE_PATH must point to a working Node executable.'); }
		command = explicitNode ?? launch.environment.PATH!.split(process.platform === 'win32' ? ';' : ':').map((directory) => paths.join(directory, process.platform === 'win32' ? 'node.exe' : 'node')).find(executable) ?? process.execPath;
		argumentsValue = [script, ...args];
		launch.environment.PATH = [...new Set([paths.dirname(command), ...launch.environment.PATH!.split(process.platform === 'win32' ? ';' : ':')])].join(process.platform === 'win32' ? ';' : ':');
		if (command === process.execPath && process.versions.electron !== undefined) { launch.environment.ELECTRON_RUN_AS_NODE = '1'; }
	}
	return spawn(command, argumentsValue, { ...options, env: launch.environment, shell: false });
}
