import type { JsonObject, JsonValue, SessionEvent } from './events';

export interface TimelineDetail {
	readonly label: string;
	readonly value: string;
}

export interface TimelineEventPresentation {
	readonly title: string;
	readonly details: readonly TimelineDetail[];
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function values(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function record(value: unknown): JsonObject | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function printable(value: JsonValue): string {
	return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function command(payload: JsonObject): string | undefined {
	const executable = text(payload.executable) ?? text(payload.command);
	return executable === undefined ? undefined : [executable, ...values(payload.args)].join(' ');
}

function toolPath(payload: JsonObject): string | undefined {
	const argumentsValue = record(payload.arguments);
	return text(argumentsValue?.file_path) ?? text(argumentsValue?.path);
}

function duration(payload: JsonObject): string | undefined {
	return typeof payload.durationMs === 'number' && Number.isFinite(payload.durationMs) && payload.durationMs >= 0
		? `${payload.durationMs} ms`
		: undefined;
}

function humanize(value: string): string {
	return value.replace(/[._/-]+/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

function details(...entries: readonly (TimelineDetail | undefined)[]): readonly TimelineDetail[] {
	return entries.filter((entry): entry is TimelineDetail => entry !== undefined);
}

function detail(label: string, value: JsonValue | undefined): TimelineDetail | undefined {
	return value === undefined ? undefined : { label, value: printable(value) };
}

function presentationFor(payload: JsonObject, kind: SessionEvent['kind']): TimelineEventPresentation {
	switch (kind) {
		case 'agent.message': {
			const role = text(payload.role);
			return {
				title: role === 'user' ? 'User request' : role === 'assistant' || text(payload.source) === 'assistant-commentary' ? 'Assistant update' : 'Agent message',
				details: details(detail('Message', text(payload.text))),
			};
		}
		case 'agent.summary': {
			const source = text(payload.source);
			const title = source === 'plan'
				? 'Agent plan'
				: source === 'reasoning-summary'
					? 'Agent reasoning summary'
					: 'Agent summary';
			return { title, details: details(detail('Summary', text(payload.summary) ?? text(payload.message)), detail('Plan', payload.plan)) };
		}
		case 'instruction.loaded':
			return { title: `Loaded instructions: ${text(payload.path) ?? 'source unavailable'}`, details: details(detail('Adapter', text(payload.adapter)), detail('Type', text(payload.memoryType)), detail('Reason', text(payload.loadReason)), detail('Triggered by', text(payload.triggerPath))) };
		case 'tool.called':
			return { title: `Tool started: ${text(payload.tool) ?? 'unnamed tool'}`, details: details(detail('Target path', toolPath(payload)), detail('Arguments', payload.arguments)) };
		case 'tool.completed':
			return {
				title: `${payload.success === true ? 'Tool completed' : 'Tool failed'}: ${text(payload.tool) ?? 'unnamed tool'}`,
				details: details(detail('Result', payload.result), detail('Error', text(payload.error))),
			};
		case 'command.started':
			return { title: `Agent command started: ${command(payload) ?? 'command unavailable'}`, details: [] };
		case 'command.completed':
			return { title: `Agent command ${payload.exitCode === 0 ? 'passed' : 'finished'}: ${command(payload) ?? 'command unavailable'}`, details: details(detail('Exit code', payload.exitCode), detail('Duration', duration(payload))) };
		case 'file.read':
			return {
				title: `${text(payload.pathType) === 'directory' ? 'Inspected directory' : text(payload.pathType) === 'file' ? 'Read file' : 'Read path'}: ${text(payload.path) ?? 'path unavailable'}`,
				details: details(detail('Tool', text(payload.tool))),
			};
		case 'file.changed':
			return { title: `${humanize(text(payload.operation) ?? 'changed')} file: ${text(payload.path) ?? 'path unavailable'}`, details: [] };
		case 'workspace.changed':
			return {
				title: `Workspace watcher reported ${text(payload.eventType) ?? 'a change'}: ${text(payload.path) ?? 'path unavailable'}`,
				details: details(detail('Details', text(payload.message))),
			};
		case 'workspace.diff': {
			const current = record(payload.current);
			const paths = values(current?.paths);
			return {
				title: payload.available === false
					? 'Workspace change snapshot unavailable'
					: payload.changedSinceStart === true ? 'Workspace changes detected' : 'Workspace changes unchanged',
				details: details(detail('Changed files', paths.length === 0 ? undefined : [...paths]), detail('Diff SHA-256', text(current?.diffSha256)), detail('Capture truncated', current?.truncated === true ? 'yes' : undefined)),
			};
		}
		case 'test.completed':
			return { title: `Test ${payload.success === true ? 'passed' : 'failed'}: ${text(payload.name) ?? 'unnamed test'}`, details: details(detail('Duration', duration(payload))) };
		case 'usage.reported':
			return {
				title: `Provider usage recorded: ${typeof payload.totalTokens === 'number' ? payload.totalTokens.toLocaleString() : 'unknown'} tokens`,
				details: details(detail('Provider', text(payload.provider)), detail('Model', text(payload.model)), detail('Source', text(payload.source)), detail('Input tokens', payload.inputTokens), detail('Output tokens', payload.outputTokens), detail('Reasoning tokens', payload.reasoningTokens), detail('Cache read tokens', payload.cacheReadTokens), detail('Cache write tokens', payload.cacheWriteTokens)),
			};
		case 'usage.unavailable':
			return { title: 'Token count not reported', details: details(detail('Details', text(payload.message)), detail('Provider', text(payload.provider))) };
		case 'process.started':
			return { title: `Managed process started: ${command(payload) ?? 'command unavailable'}`, details: [] };
		case 'process.output':
			return { title: `Process output: ${text(payload.stream) ?? 'stdout'}`, details: details(detail('Output', text(payload.text))) };
		case 'process.completed':
			return { title: `Managed process ${payload.cancelled === true ? 'stopped' : payload.succeeded === true ? 'completed successfully' : 'finished'}${typeof payload.exitCode === 'number' ? ` with exit code ${payload.exitCode}` : ''}`, details: details(detail('Signal', text(payload.signal))) };
		case 'process.failed':
			return { title: 'Managed process failed', details: details(detail('Error', text(payload.message))) };
		case 'log.truncated':
			return { title: 'Log output was truncated', details: details(detail('Stream', text(payload.stream)), detail('Omitted characters', payload.omittedCharacters), detail('Retention limit', payload.limit)) };
		case 'session.started':
			return { title: `Session started: ${text(payload.runMode) ?? 'unknown'} run`, details: details(detail('Actor', text(payload.actor))) };
		case 'session.completed':
			return { title: 'Session completed', details: [] };
		case 'session.interrupted':
			return { title: 'Session stopped', details: [] };
		case 'session.failed':
			return { title: 'Session failed', details: details(detail('State', text(payload.state))) };
		case 'adapter.lifecycle':
			return {
				title: `${humanize(text(payload.adapter) ?? 'adapter')}: ${humanize(text(payload.phase) ?? 'status update')}`,
				details: details(detail('Message', text(payload.message)), detail('Model', text(payload.model)), detail('Reason', text(payload.reason))),
			};
	}
}

/**
 * Produces a safe human-readable view of already-redacted canonical evidence.
 * Provider raw reasoning is not a canonical event payload and is never rendered.
 */
export function presentSessionEvent(event: SessionEvent): TimelineEventPresentation {
	return presentationFor(event.payload, event.kind);
}

/** Formats a session event as a readable text block for live and historic timelines. */
export function formatSessionEventText(event: SessionEvent): readonly string[] {
	const presentation = presentSessionEvent(event);
	const lines = [
		`[${String(event.sequence).padStart(4, '0')}] ${event.occurredAt} | ${event.evidenceGrade} | ${event.kind}`,
		`  ${presentation.title}`,
	];
	for (const entry of presentation.details) {
		const detailLines = entry.value.replace(/\r\n?/g, '\n').split('\n');
		lines.push(`  ${entry.label}: ${detailLines[0] ?? ''}`);
		for (const line of detailLines.slice(1)) {
			lines.push(`    ${line}`);
		}
	}
	if (event.correlationId !== undefined) {
		lines.push(`  Correlation: ${event.correlationId}`);
	}
	if (event.unknownReason !== undefined) {
		lines.push(`  Missing details: ${event.unknownReason}`);
	}
	if (event.redaction.replacements > 0) {
		lines.push(`  Sensitive data hidden: ${event.redaction.replacements} value(s)`);
	}
	if (event.redaction.truncated) {
		lines.push('  Output shortened at the configured size limit');
	}
	return lines;
}