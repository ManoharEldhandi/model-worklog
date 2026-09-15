import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { writeJson, writeJsonLine, writeLine } from '../output';
import { requestSupervisor, type EventsResult, type SessionResult } from '../supervisorApi';

function oneLine(value: unknown): string {
	return JSON.stringify(value).replace(/[\r\n]+/g, ' ').slice(0, 140);
}

function subject(event: EventsResult['events'][number]): string {
	const payload = event.payload as Record<string, unknown>;
	if (event.kind === 'process.output' && typeof payload.text === 'string') {
		return payload.text.replace(/[\r\n]+/g, ' ').slice(0, 140);
	}
	if (event.kind === 'process.started' && typeof payload.executable === 'string') {
		const args = Array.isArray(payload.args) ? payload.args.filter((value): value is string => typeof value === 'string') : [];
		return [payload.executable, ...args].join(' ').slice(0, 140);
	}
	if (event.kind === 'agent.summary' && typeof payload.summary === 'string') {
		return payload.summary.slice(0, 140);
	}
	return oneLine(payload);
}

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
	writeLine(context.stdout, `Session ${session.sessionId} (${session.state}, ${session.runMode})`);
	writeLine(context.stdout, 'SEQ  TIME          GRADE              ACTOR        KIND                 SUBJECT');
	for (const event of eventsOutcome.data.events) {
		const time = event.occurredAt.slice(11, 23);
		writeLine(context.stdout, `${String(event.sequence).padEnd(4)} ${time.padEnd(13)} ${event.evidenceGrade.padEnd(18)} ${event.actor.padEnd(12)} ${event.kind.padEnd(20)} ${subject(event)}`);
		if (event.unknownReason !== undefined) {
			writeLine(context.stdout, `     evidence gap: ${event.unknownReason}`);
		}
	}
	const tokens = session.tokenUsage.status === 'reported'
		? `Tokens: ${session.tokenUsage.totalTokens} total (${session.tokenUsage.source}; ${session.tokenUsage.providers.length === 0 ? 'provider unknown' : `providers ${session.tokenUsage.providers.join(', ')}`}; ${session.tokenUsage.models.length === 0 ? 'model unknown' : `models ${session.tokenUsage.models.join(', ')}`}; input ${session.tokenUsage.inputTokens}, output ${session.tokenUsage.outputTokens}, reasoning ${session.tokenUsage.reasoningTokens}, cache read ${session.tokenUsage.cacheReadTokens}, cache write ${session.tokenUsage.cacheWriteTokens})`
		: `Tokens: unknown (${session.tokenUsage.reason})`;
	writeLine(context.stdout, tokens);
	return ExitCode.Ok;
}