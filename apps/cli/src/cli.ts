import { costCommand } from './commands/cost';
import { exportEvidenceBundleCommand, verifyEvidenceBundleCommand } from './commands/evidenceBundle';
import { doctorCommand } from './commands/doctor';
import { logsCommand } from './commands/logs';
import { runCommand } from './commands/run';
import { sessionsCommand } from './commands/sessions';
import { supervisorStatusCommand } from './commands/supervisorStatus';
import { supervisorStartCommand } from './commands/supervisorStart';
import { watchCommand } from './commands/watch';
import { workspaceCommand } from './commands/workspace';
import { optionFlag, optionString, parseArgs } from './args';
import { CLI_VERSION, DEFAULT_SUPERVISOR_URL, ExitCode, type EnvRecord } from './constants';
import type { CommandContext } from './context';
import { resolveColor, resolveFormat, writeLine, type OutputStream } from './output';
import type { FetchLike } from './protocolClient';

export interface CliEnvironment {
	readonly argv: readonly string[];
	readonly env: EnvRecord;
	readonly stdout: OutputStream;
	readonly stderr: OutputStream;
	readonly fetchImpl?: FetchLike;
}

const HELP = `model-worklog — local AI session logging and review

Usage:
  model-worklog <command> [options]

Commands:
  doctor                 Check the CLI installation and supervisor reachability
	supervisor start       Start or reuse the packaged local supervisor
	supervisor status      Show the local supervisor health and capabilities
	workspace trust [path] Explicitly trust a workspace for managed execution
	workspace status [path] Show whether a workspace is trusted
	run -- <command>       Run a trusted command with boundary evidence capture
	watch <session-id>     Follow committed events with resumable filters
	cost <session-id>      Calculate cost from a versioned price table
	export <session-id>    Write a portable redacted evidence bundle
	verify <file>          Verify an evidence bundle manifest through the supervisor
	sessions list          List retained sessions
	logs <session-id>      Render one session as a timeline

Options:
  --supervisor-url <url> Loopback supervisor URL (default ${DEFAULT_SUPERVISOR_URL})
	--format <pretty|json|jsonl> Output format (default: pretty on a TTY, else json)
	--actor <name>         Label a managed command run
	--output <file>        Evidence bundle destination for export
	--after-sequence <n>   Resume watch after a committed event sequence
	--kind <names>         Comma-separated event kinds for watch
	--grade <grades>       Comma-separated evidence grades for watch
	--path <fragment>      Filter watch events by path fragment
	--command <fragment>   Filter watch events by command fragment
	--interval-ms <n>      Watch polling interval (default 250)
	--once                 Fetch one watch snapshot and exit
  --require-supervisor   Make doctor fail when the supervisor is unavailable
  --version, -V          Print the CLI version
  --help, -h             Show this help

Environment:
  MODEL_WORKLOG_SUPERVISOR_URL  Overrides the default supervisor URL
  NO_COLOR / FORCE_COLOR         Disable / force ANSI color`;

export async function runCli(environment: CliEnvironment): Promise<number> {
	const { positionals, options } = parseArgs(environment.argv);

	if (optionFlag(options, 'version', 'V')) {
		writeLine(environment.stdout, CLI_VERSION);
		return ExitCode.Ok;
	}

	const wantsHelp = optionFlag(options, 'help', 'h');
	if (positionals.length === 0) {
		writeLine(wantsHelp ? environment.stdout : environment.stderr, HELP);
		return wantsHelp ? ExitCode.Ok : ExitCode.InvalidInvocation;
	}
	if (wantsHelp) {
		writeLine(environment.stdout, HELP);
		return ExitCode.Ok;
	}

	const isTTY = Boolean(environment.stdout.isTTY);
	const format = resolveFormat(optionString(options, 'format'), isTTY);
	if (format === undefined) {
		writeLine(environment.stderr, 'Invalid --format. Use "pretty", "json", or "jsonl".');
		return ExitCode.InvalidInvocation;
	}

	const context: CommandContext = {
		stdout: environment.stdout,
		stderr: environment.stderr,
		env: environment.env,
		format,
		color: resolveColor(isTTY, environment.env),
		supervisorUrl: optionString(options, 'supervisor-url') ?? environment.env.MODEL_WORKLOG_SUPERVISOR_URL ?? DEFAULT_SUPERVISOR_URL,
		fetchImpl: environment.fetchImpl,
	};

	const command = positionals[0];
	switch (command) {
		case 'doctor':
			return doctorCommand(context, { requireSupervisor: optionFlag(options, 'require-supervisor') });
		case 'supervisor': {
			const sub = positionals[1];
			if (sub === 'start') {
				return supervisorStartCommand(context);
			}
			if (sub === 'status') {
				return supervisorStatusCommand(context);
			}
			writeLine(environment.stderr, sub === undefined ? 'Usage: model-worklog supervisor <start|status>' : `Unknown supervisor subcommand: ${sub}`);
			return ExitCode.InvalidInvocation;
		}
		case 'workspace':
			return workspaceCommand(context, positionals[1], positionals[2]);
		case 'run':
			return runCommand(context, positionals.slice(1), optionString(options, 'actor'));
		case 'watch':
			return watchCommand(context, positionals[1], {
				afterSequence: optionString(options, 'after-sequence'),
				kind: optionString(options, 'kind'),
				grade: optionString(options, 'grade'),
				actor: optionString(options, 'actor'),
				path: optionString(options, 'path'),
				command: optionString(options, 'command'),
				intervalMs: optionString(options, 'interval-ms'),
				once: optionFlag(options, 'once'),
			});
		case 'cost':
			return costCommand(context, positionals[1]);
		case 'export':
			return exportEvidenceBundleCommand(context, positionals[1], optionString(options, 'output'));
		case 'verify':
			return verifyEvidenceBundleCommand(context, positionals[1]);
		case 'sessions':
			if (positionals[1] === 'list') {
				return sessionsCommand(context);
			}
			writeLine(environment.stderr, 'Usage: model-worklog sessions list');
			return ExitCode.InvalidInvocation;
		case 'logs':
			return logsCommand(context, positionals[1]);
		default:
			writeLine(environment.stderr, `Unknown command: ${command}`);
			writeLine(environment.stderr, HELP);
			return ExitCode.InvalidInvocation;
	}
}
