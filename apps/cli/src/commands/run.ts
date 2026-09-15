import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { writeJson, writeJsonLine, writeLine } from '../output';
import { requestSupervisor, type SessionResult } from '../supervisorApi';

export async function runCommand(context: CommandContext, command: readonly string[], actor: string | undefined): Promise<ExitCode> {
	const executable = command[0];
	if (executable === undefined) {
		writeLine(context.stderr, 'Usage: model-worklog run [--actor <name>] -- <executable> [arguments...]');
		return ExitCode.InvalidInvocation;
	}
	const outcome = await requestSupervisor<SessionResult>(context, '/v1/runs', 'POST', {
		workspacePath: process.cwd(), executable, args: command.slice(1), ...(actor === undefined ? {} : { actor }),
	});
	if (outcome.kind === 'error') {
		writeLine(context.stderr, outcome.message);
		return outcome.statusCode === 403 ? ExitCode.InvalidInvocation : ExitCode.Unavailable;
	}
	if (context.format === 'pretty') {
		writeLine(context.stdout, `Started session ${outcome.data.session.sessionId}`);
		writeLine(context.stdout, `Run 'model-worklog logs ${outcome.data.session.sessionId}' to inspect its committed evidence.`);
	} else if (context.format === 'jsonl') {
		writeJsonLine(context.stdout, { schemaVersion: 1, command: 'run', result: outcome.data });
	} else {
		writeJson(context.stdout, { schemaVersion: 1, command: 'run', result: outcome.data });
	}
	return ExitCode.Ok;
}