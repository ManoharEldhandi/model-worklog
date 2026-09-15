import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { writeJson, writeJsonLine, writeLine } from '../output';
import { requestSupervisor, type EventsResult, type SessionResult } from '../supervisorApi';
import { formatSessionEventText } from 'model-worklog-schema';

export async function logsCommand(context: CommandContext, sessionId: string | undefined): Promise<ExitCode> {
	if (sessionId === undefined) {
		writeLine(context.stderr, 'Usage: model-worklog logs <session-id>');
		return ExitCode.InvalidInvocation;
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
	const session = sessionOutcome.data.session;
	writeLine(context.stdout, `Log: ${session.title ?? session.sessionId} (${session.state}, ${session.runMode})`);
	if (session.title !== undefined) {
		writeLine(context.stdout, `Session: ${session.sessionId}`);
	}
	for (const event of eventsOutcome.data.events) {
		for (const line of formatSessionEventText(event)) {
			writeLine(context.stdout, line);
		}
	}
	const tokens = session.tokenUsage.status === 'reported'
		? `Tokens: ${session.tokenUsage.totalTokens} total (${session.tokenUsage.source}; ${session.tokenUsage.providers.length === 0 ? 'provider unknown' : `providers ${session.tokenUsage.providers.join(', ')}`}; ${session.tokenUsage.models.length === 0 ? 'model unknown' : `models ${session.tokenUsage.models.join(', ')}`}; input ${session.tokenUsage.inputTokens}, output ${session.tokenUsage.outputTokens}, reasoning ${session.tokenUsage.reasoningTokens}, cache read ${session.tokenUsage.cacheReadTokens}, cache write ${session.tokenUsage.cacheWriteTokens})`
		: `Tokens: unknown (${session.tokenUsage.reason})`;
	writeLine(context.stdout, tokens);
	return ExitCode.Ok;
}