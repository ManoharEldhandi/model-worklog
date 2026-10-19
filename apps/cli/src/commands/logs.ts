import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { writeJson, writeJsonLine, writeLine } from '../output';
import { requestSupervisor, type EventsResult, type SessionResult } from '../supervisorApi';
import { ActivityLogSchema } from 'model-worklog-schema';

export async function logsCommand(context: CommandContext, sessionId: string | undefined): Promise<ExitCode> {
	if (sessionId === undefined) {
		writeLine(context.stderr, 'Usage: model-worklog logs <session-id>');
		return ExitCode.InvalidInvocation;
	}
	if (context.format === 'pretty') {
		const [session, result] = await Promise.all([
			requestSupervisor<SessionResult>(context, `/v1/sessions/${encodeURIComponent(sessionId)}`),
			requestSupervisor<unknown>(context, `/v1/sessions/${encodeURIComponent(sessionId)}/log`),
		]);
		if (session.kind === 'error' || result.kind === 'error') { writeLine(context.stderr, session.kind === 'error' ? session.message : result.kind === 'error' ? result.message : 'Log unavailable'); return ExitCode.Unavailable; }
		const parsed = ActivityLogSchema.safeParse(result.data);
		if (!parsed.success || parsed.data.sessionId !== sessionId) { writeLine(context.stderr, 'Supervisor returned an invalid activity log.'); return ExitCode.Internal; }
		writeLine(context.stdout, `Log: ${session.data.session.title ?? sessionId} (${parsed.data.state}, ${session.data.session.runMode})`);
		writeLine(context.stdout, `Session: ${sessionId}`);
		for (const line of parsed.data.lines) { writeLine(context.stdout, line); }
		return ExitCode.Ok;
	}
	const [sessionOutcome, eventsOutcome] = await Promise.all([
		requestSupervisor<SessionResult>(context, `/v1/sessions/${encodeURIComponent(sessionId)}`),
		requestSupervisor<EventsResult>(context, `/v1/sessions/${encodeURIComponent(sessionId)}/events`),
	]);
	if (sessionOutcome.kind === 'error') {
		writeLine(context.stderr, sessionOutcome.message);
		return ExitCode.Unavailable;
	}
	if (eventsOutcome.kind === 'error') {
		writeLine(context.stderr, eventsOutcome.message);
		return ExitCode.Unavailable;
	}
	if (context.format === 'jsonl') {
		for (const event of eventsOutcome.data.events) {
			writeJsonLine(context.stdout, event);
		}
		return ExitCode.Ok;
	}
	if (context.format === 'json') {
		writeJson(context.stdout, { schemaVersion: 1, command: 'logs', result: { session: sessionOutcome.data.session, events: eventsOutcome.data.events } });
		return ExitCode.Ok;
	}
	return ExitCode.Ok;
}