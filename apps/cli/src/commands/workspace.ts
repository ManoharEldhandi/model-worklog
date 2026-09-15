import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { writeJson, writeJsonLine, writeLine } from '../output';
import { requestSupervisor, type WorkspaceResult } from '../supervisorApi';

export async function workspaceCommand(context: CommandContext, subcommand: string | undefined, workspacePath: string | undefined): Promise<ExitCode> {
	if (subcommand !== 'trust' && subcommand !== 'status') {
		writeLine(context.stderr, 'Usage: model-worklog workspace <trust|status> [path]');
		return ExitCode.InvalidInvocation;
	}
	const outcome = await requestSupervisor<WorkspaceResult>(context, `/v1/workspaces/${subcommand}`, 'POST', { workspacePath: workspacePath ?? process.cwd() });
	if (outcome.kind === 'error') {
		writeLine(context.stderr, outcome.message);
		return outcome.statusCode === 401 || outcome.statusCode === 403 ? ExitCode.InvalidInvocation : ExitCode.Unavailable;
	}
	if (context.format === 'pretty') {
		writeLine(context.stdout, `Workspace ${outcome.data.workspace.label}: ${outcome.data.trusted ? 'trusted' : 'not trusted'}`);
		writeLine(context.stdout, `  fingerprint  ${outcome.data.workspace.fingerprint}`);
		if (outcome.data.workspace.trustedAt !== undefined) {
			writeLine(context.stdout, `  trusted at   ${outcome.data.workspace.trustedAt}`);
		}
	} else if (context.format === 'jsonl') {
		writeJsonLine(context.stdout, { schemaVersion: 1, command: `workspace.${subcommand}`, result: outcome.data });
	} else {
		writeJson(context.stdout, { schemaVersion: 1, command: `workspace.${subcommand}`, result: outcome.data });
	}
	return ExitCode.Ok;
}