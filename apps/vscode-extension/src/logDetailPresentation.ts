import type { JsonObject, JsonValue, SessionEvent, TokenUsageSummary } from 'model-worklog-schema';

import type { SupervisorSession } from './supervisorApi';

export interface LogDetailEntry {
	readonly label: string;
	readonly content?: string;
}

export interface LogDetailSection {
	readonly title: string;
	readonly entries: readonly LogDetailEntry[];
}

export interface LogDetailModel {
	readonly sessionId: string;
	readonly title: string;
	readonly status: 'live' | 'completed' | 'failed' | 'stopped';
	readonly updateCount: number;
	readonly sections: readonly LogDetailSection[];
}

interface TokenTotals {
	readonly source?: string;
	readonly providers: readonly string[];
	readonly models: readonly string[];
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cacheReadTokens: number;
	readonly cacheWriteTokens: number;
	readonly reasoningTokens: number;
	readonly totalTokens: number;
}

const MAX_SECTION_ENTRIES = 100;
const MAX_TEXT_CHARS = 16_000;

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function object(value: unknown): JsonObject | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function formatValue(value: JsonValue | undefined): string | undefined {
	if (value === undefined) {
		return undefined;
	}
	const formatted = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
	return formatted.length <= MAX_TEXT_CHARS
		? formatted
		: `${formatted.slice(0, MAX_TEXT_CHARS)}\n\nShowing the first ${MAX_TEXT_CHARS.toLocaleString()} characters. Download JSON for the complete log.`;
}

function status(session: SupervisorSession): LogDetailModel['status'] {
	switch (session.state) {
		case 'running':
			return 'live';
		case 'failed':
			return 'failed';
		case 'interrupted':
			return 'stopped';
		default:
			return 'completed';
	}
}

function title(session: SupervisorSession): string {
	if (session.title !== undefined) {
		return session.title;
	}
	return session.actor === 'codex-app-server'
		? 'Codex activity'
		: session.runMode === 'managed'
			? 'Command activity'
			: `${session.actor} activity`;
}

function titleFromEvents(events: readonly SessionEvent[]): string | undefined {
	const request = events.find((event) => event.kind === 'agent.message' && event.payload.role === 'user' && typeof event.payload.text === 'string');
	if (request === undefined || typeof request.payload.text !== 'string') {
		return undefined;
	}
	const compact = request.payload.text.replace(/\s+/g, ' ').trim();
	return compact === '' ? undefined : compact.slice(0, 160);
}

function section(titleValue: string, entries: readonly LogDetailEntry[]): LogDetailSection | undefined {
	if (entries.length === 0) {
		return undefined;
	}
	const hidden = Math.max(0, entries.length - MAX_SECTION_ENTRIES);
	return {
		title: titleValue,
		entries: hidden === 0
			? entries
			: [{ label: `Showing the latest ${MAX_SECTION_ENTRIES} updates. Download JSON for the complete log.` }, ...entries.slice(-MAX_SECTION_ENTRIES)],
	};
}

function eventTime(event: SessionEvent): string {
	return event.occurredAt.slice(11, 19);
}

function command(payload: JsonObject): string {
	const executable = text(payload.executable) ?? text(payload.command) ?? 'command';
	const args = Array.isArray(payload.args) ? payload.args.filter((value): value is string => typeof value === 'string') : [];
	return [executable, ...args].join(' ');
}

function detail(label: string, value: JsonValue | undefined): LogDetailEntry | undefined {
	const content = formatValue(value);
	return content === undefined ? undefined : { label, content };
}

function eventDetail(label: string, values: readonly (LogDetailEntry | undefined)[]): LogDetailEntry {
	return {
		label,
		content: values.filter((value): value is LogDetailEntry => value !== undefined).map((value) => `${value.label}:\n${value.content ?? ''}`).join('\n\n') || undefined,
	};
}

function reportedTokenTotals(events: readonly SessionEvent[]): TokenTotals | undefined {
	const reports = events.filter((event) => event.kind === 'usage.reported');
	if (reports.length === 0) {
		return undefined;
	}
	const providers = new Set<string>();
	const models = new Set<string>();
	let source: string | undefined;
	let inputTokens = 0;
	let outputTokens = 0;
	let cacheReadTokens = 0;
	let cacheWriteTokens = 0;
	let reasoningTokens = 0;
	let totalTokens = 0;
	for (const report of reports) {
		const payload = report.payload;
		const provider = text(payload.provider);
		const model = text(payload.model);
		providers.add(provider ?? 'Provider not named');
		if (model !== undefined) {
			models.add(model);
		}
		source ??= text(payload.source);
		inputTokens += number(payload.inputTokens) ?? 0;
		outputTokens += number(payload.outputTokens) ?? 0;
		cacheReadTokens += number(payload.cacheReadTokens) ?? 0;
		cacheWriteTokens += number(payload.cacheWriteTokens) ?? 0;
		reasoningTokens += number(payload.reasoningTokens) ?? 0;
		totalTokens += number(payload.totalTokens) ?? 0;
	}
	return { source, providers: [...providers], models: [...models], inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens };
}

function sessionTokenTotals(summary: TokenUsageSummary): TokenTotals | undefined {
	if (summary.status !== 'reported') {
		return undefined;
	}
	return {
		source: summary.source,
		providers: summary.providers,
		models: summary.models,
		inputTokens: summary.inputTokens,
		outputTokens: summary.outputTokens,
		cacheReadTokens: summary.cacheReadTokens,
		cacheWriteTokens: summary.cacheWriteTokens,
		totalTokens: summary.totalTokens,
		reasoningTokens: summary.reasoningTokens,
	};
}

function tokenSection(session: SupervisorSession, events: readonly SessionEvent[]): LogDetailSection | undefined {
	const totals = reportedTokenTotals(events) ?? sessionTokenTotals(session.tokenUsage);
	if (totals === undefined) {
		return undefined;
	}
	return {
		title: 'Tokens Used',
		entries: [
			{ label: `Total: ${totals.totalTokens.toLocaleString()}` },
			{ label: `Input: ${totals.inputTokens.toLocaleString()}` },
			{ label: `Output: ${totals.outputTokens.toLocaleString()}` },
			{ label: `Reasoning: ${totals.reasoningTokens.toLocaleString()}` },
			{ label: `Cache read: ${totals.cacheReadTokens.toLocaleString()}` },
			{ label: `Cache write: ${totals.cacheWriteTokens.toLocaleString()}` },
			...(totals.providers.length === 0 ? [] : [{ label: `Provider: ${totals.providers.join(', ')}` }]),
			...(totals.models.length === 0 ? [] : [{ label: `Model: ${totals.models.join(', ')}` }]),
			...(totals.source === undefined ? [] : [{ label: `Reported as: ${totals.source}` }]),
		],
	};
}

/** Builds one readable, sectioned view of a selected session's saved activity. */
export function buildLogDetail(session: SupervisorSession, events: readonly SessionEvent[]): LogDetailModel {
	const userRequests: LogDetailEntry[] = [];
	const plans: LogDetailEntry[] = [];
	const reasoning: LogDetailEntry[] = [];
	const agentResponses: LogDetailEntry[] = [];
	const tools: LogDetailEntry[] = [];
	const files: LogDetailEntry[] = [];
	const commands: LogDetailEntry[] = [];
	const output: LogDetailEntry[] = [];
	const tests: LogDetailEntry[] = [];
	const notes: LogDetailEntry[] = [];

	for (const event of events) {
		const payload = event.payload;
		const time = eventTime(event);
		if (event.kind === 'agent.message') {
			const message = text(payload.text);
			if (message !== undefined) {
				(event.payload.role === 'user' ? userRequests : agentResponses).push({ label: time, content: message });
			}
			continue;
		}
		if (event.kind === 'agent.summary') {
			const summary = text(payload.summary) ?? text(payload.message);
			const source = text(payload.source);
			if (source === 'plan') {
				plans.push(eventDetail(time, [detail('Plan', summary), detail('Steps', payload.plan)]));
			} else if (source === 'reasoning-summary') {
				if (summary !== undefined) {
					reasoning.push({ label: time, content: summary });
				}
			} else if (summary !== undefined) {
				agentResponses.push({ label: time, content: summary });
			}
			continue;
		}
		if (event.kind === 'tool.called') {
			const tool = text(payload.tool) ?? 'Unnamed tool';
			tools.push(eventDetail(`${time}  ${tool} selected`, [detail('Target file', object(payload.arguments)?.path ?? object(payload.arguments)?.file_path), detail('Arguments', payload.arguments)]));
			continue;
		}
		if (event.kind === 'tool.completed') {
			const tool = text(payload.tool) ?? 'Unnamed tool';
			tools.push(eventDetail(`${time}  ${tool} ${payload.success === true ? 'completed' : 'failed'}`, [detail('Result', payload.result), detail('Error', text(payload.error))]));
			continue;
		}
		if (event.kind === 'file.read') {
			files.push({ label: `${time}  Read ${text(payload.path) ?? 'a file'}`, content: text(payload.tool) === undefined ? undefined : `Using ${text(payload.tool)}` });
			continue;
		}
		if (event.kind === 'file.changed') {
			files.push({ label: `${time}  ${text(payload.operation) ?? 'Changed'} ${text(payload.path) ?? 'a file'}` });
			continue;
		}
		if (event.kind === 'command.started' || event.kind === 'process.started') {
			commands.push({ label: `${time}  Started ${command(payload)}` });
			continue;
		}
		if (event.kind === 'command.completed' || event.kind === 'process.completed' || event.kind === 'process.failed') {
			const statusValue = event.kind === 'process.failed' ? 'failed to start' : payload.exitCode === 0 || payload.succeeded === true ? 'passed' : 'finished';
			commands.push(eventDetail(`${time}  ${statusValue}: ${command(payload)}`, [detail('Exit code', payload.exitCode), detail('Signal', text(payload.signal)), detail('Details', text(payload.message))]));
			continue;
		}
		if (event.kind === 'process.output') {
			output.push({ label: `${time}  ${text(payload.stream) ?? 'Output'}`, content: text(payload.text) });
			continue;
		}
		if (event.kind === 'test.completed') {
			tests.push(eventDetail(`${time}  ${payload.success === true ? 'Passed' : 'Failed'}: ${text(payload.name) ?? 'Unnamed test'}`, [detail('Duration', typeof payload.durationMs === 'number' ? `${payload.durationMs} ms` : undefined)]));
			continue;
		}
		if (event.kind === 'instruction.loaded') {
			notes.push(eventDetail(`${time}  Loaded instructions: ${text(payload.path) ?? 'source not named'}`, [detail('From', text(payload.adapter)), detail('Reason', text(payload.loadReason))]));
			continue;
		}
		if (event.kind === 'adapter.lifecycle') {
			notes.push(eventDetail(`${time}  ${text(payload.adapter) ?? 'AI connection'}: ${text(payload.phase) ?? 'status update'}`, [detail('Details', text(payload.message)), detail('Model', text(payload.model)), detail('Reason', text(payload.reason))]));
			continue;
		}
		if (event.kind === 'workspace.diff') {
			const current = object(payload.current);
			notes.push(eventDetail(`${time}  ${payload.changedSinceStart === true ? 'Workspace changes found' : 'Workspace changes checked'}`, [detail('Changed files', current?.paths), detail('Details', payload.available === false ? 'A workspace change snapshot was not available.' : undefined)]));
			continue;
		}
		if (event.kind === 'usage.unavailable') {
			notes.push(eventDetail(`${time}  Token count not reported`, [detail('Details', text(payload.message))]));
			continue;
		}
		if (event.kind === 'usage.reported') {
			continue;
		}
		if (event.kind === 'log.truncated') {
			notes.push(eventDetail(`${time}  Output shortened`, [detail('Stream', text(payload.stream)), detail('Omitted characters', payload.omittedCharacters)]));
			continue;
		}
		if (event.kind === 'session.started' || event.kind === 'session.completed' || event.kind === 'session.interrupted' || event.kind === 'session.failed') {
			continue;
		}
		notes.push(eventDetail(`${time}  ${event.kind}`, [detail('Details', payload)]));
	}

	return {
		sessionId: session.sessionId,
		title: session.title ?? titleFromEvents(events) ?? title(session),
		status: status(session),
		updateCount: session.eventCount,
		sections: [
			section('User Request', userRequests),
			section('Agent Plan', plans),
			section('Reasoning Summary', reasoning),
			section('Tools Used', tools),
			section('Files', files),
			section('Commands', commands),
			section('Output', output),
			section('Tests', tests),
			section('Agent Response', agentResponses),
			section('Session Notes', notes),
			tokenSection(session, events),
		].filter((value): value is LogDetailSection => value !== undefined),
	};
}