import { LogQueryRequestSchema, LogQueryResponseSchema } from 'model-worklog-schema';

import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { writeJson, writeJsonLine, writeLine } from '../output';
import { requestSupervisor } from '../supervisorApi';

export interface AskOptions {
	readonly projectId?: string;
	readonly traceId?: string;
	readonly toolName?: string;
	readonly since?: string;
	readonly until?: string;
	readonly intent?: string;
	readonly synthesis?: string;
	readonly limit?: string;
}

export async function askCommand(context: CommandContext, question: string, options: AskOptions): Promise<ExitCode> {
	const parsed = LogQueryRequestSchema.safeParse({ ...options, question, limit: options.limit === undefined ? undefined : /^[1-9][0-9]*$/.test(options.limit) ? Number(options.limit) : options.limit });
	if (!parsed.success) {
		writeLine(context.stderr, 'Usage: model-worklog ask "question" --project <id> [--trace <id>] [--tool <name>] [--since <ISO>] [--until <ISO>] [--intent <auto|tools|failures|search>] [--synthesis <extractive|model>] [--limit <1-20>]');
		return ExitCode.InvalidInvocation;
	}
	const outcome = await requestSupervisor<unknown>(context, '/v2/logs/query', 'POST', parsed.data, 15_000);
	if (outcome.kind === 'error') { writeLine(context.stderr, outcome.message); return ExitCode.Unavailable; }
	const response = LogQueryResponseSchema.safeParse(outcome.data);
	if (!response.success || response.data.scope.projectId !== parsed.data.projectId || response.data.scope.traceId !== parsed.data.traceId) {
		writeLine(context.stderr, 'Supervisor returned an invalid log query response.');
		return ExitCode.Internal;
	}
	if (context.format === 'jsonl') { writeJsonLine(context.stdout, response.data); }
	else if (context.format === 'json') { writeJson(context.stdout, { schemaVersion: 1, command: 'ask', result: response.data }); }
	else {
		writeLine(context.stdout, response.data.answer);
		for (const source of response.data.evidence) { writeLine(context.stdout, `[${source.id}] ${source.name} | ${source.traceId}/${source.spanId} revision ${source.revision}`); }
		for (const warning of response.data.limitations) { writeLine(context.stdout, `Note: ${warning}`); }
	}
	return ExitCode.Ok;
}
