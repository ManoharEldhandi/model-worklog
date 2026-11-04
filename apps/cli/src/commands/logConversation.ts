import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { LogConversationSchema, LogQueryScopeSchema, appendLogHistory, type LogConversationMessage, type LogQueryRequest, type LogQueryResponse } from 'model-worklog-schema';

function scope(request: LogQueryRequest): ReturnType<typeof LogQueryScopeSchema.parse> {
	return LogQueryScopeSchema.parse({ projectId: request.projectId, traceId: request.traceId, toolName: request.toolName, since: request.since, until: request.until });
}

export async function readLogConversation(path: string, request: LogQueryRequest): Promise<LogConversationMessage[]> {
	try {
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.size > 128 * 1024) { throw new Error(); }
		const saved = LogConversationSchema.parse(JSON.parse(await readFile(path, 'utf8')));
		if (JSON.stringify(saved.scope) !== JSON.stringify(scope(request))) { throw new Error(); }
		return saved.history;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; }
		throw new Error('Conversation file is invalid or belongs to another scope. Use a new file for a different project, trace, tool, or time range.');
	}
}

export async function saveLogConversation(path: string, request: LogQueryRequest, response: LogQueryResponse): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, JSON.stringify({ schemaVersion: 1, scope: scope(request), history: appendLogHistory(request.history, response.question ?? request.question, response.answer) }, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
		await rename(temporary, path);
	} finally { await rm(temporary, { force: true }); }
}
