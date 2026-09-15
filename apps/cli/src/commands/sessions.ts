import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { writeJson, writeJsonLine, writeLine } from '../output';
import { requestSupervisor, type SessionsResult } from '../supervisorApi';

export async function sessionsCommand(context: CommandContext): Promise<ExitCode> {
	const outcome = await requestSupervisor<SessionsResult>(context, '/v1/sessions');
	if (outcome.kind === 'error') {
		writeLine(context.stderr, outcome.message);
		return ExitCode.Unavailable;
	}
	if (context.format === 'json') {
		writeJson(context.stdout, { schemaVersion: 1, command: 'sessions.list', result: outcome.data });
		return ExitCode.Ok;
	}
	if (context.format === 'jsonl') {
		for (const session of outcome.data.sessions) {
			writeJsonLine(context.stdout, session);
		}
		return ExitCode.Ok;
	}
	if (outcome.data.sessions.length === 0) {
		writeLine(context.stdout, 'No retained sessions.');
		return ExitCode.Ok;
	}
	writeLine(context.stdout, 'SESSION                              STATE        ACTOR                 EVENTS  CREATED');
	for (const session of outcome.data.sessions) {
		writeLine(context.stdout, `${session.sessionId.padEnd(36)} ${session.state.padEnd(12)} ${session.actor.padEnd(21)} ${String(session.eventCount).padEnd(7)} ${session.createdAt}`);
	}
	return ExitCode.Ok;
}
