import { setTimeout as delay } from 'node:timers/promises';

import { ActivityLogSchema, formatActivityText, type SessionEvent } from 'model-worklog-schema';

import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { writeJson, writeJsonLine, writeLine } from '../output';
import { requestSupervisor, type EventsResult } from '../supervisorApi';

const DEFAULT_INTERVAL_MS = 250;

export interface WatchOptions {
	readonly afterSequence?: string;
	readonly kind?: string;
	readonly grade?: string;
	readonly actor?: string;
	readonly path?: string;
	readonly command?: string;
	readonly intervalMs?: string;
	readonly once: boolean;
}

function values(value: string | undefined): readonly string[] {
	return value === undefined ? [] : value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

function nonNegativeInteger(value: string | undefined, fallback: number): number | undefined {
	if (value === undefined) {
		return fallback;
	}
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function queryPath(sessionId: string, afterSequence: number, options: WatchOptions): string {
	const query = new URLSearchParams({ afterSequence: String(afterSequence) });
	for (const kind of values(options.kind)) {
		query.append('kind', kind);
	}
	for (const grade of values(options.grade)) {
		query.append('grade', grade);
	}
	for (const actor of values(options.actor)) {
		query.append('actor', actor);
	}
	if (options.path !== undefined) {
		query.set('path', options.path);
	}
	if (options.command !== undefined) {
		query.set('command', options.command);
	}
	return `/v1/sessions/${encodeURIComponent(sessionId)}/events?${query.toString()}`;
}

export async function watchCommand(context: CommandContext, sessionId: string | undefined, options: WatchOptions): Promise<ExitCode> {
	if (sessionId === undefined) {
		writeLine(context.stderr, 'Usage: model-worklog watch <session-id> [--once] [--after-sequence <n>]');
		return ExitCode.InvalidInvocation;
	}
	const afterSequence = nonNegativeInteger(options.afterSequence, 0);
	const intervalMs = nonNegativeInteger(options.intervalMs, DEFAULT_INTERVAL_MS);
	if (afterSequence === undefined || intervalMs === undefined || values(options.kind).length === 0 && options.kind !== undefined || values(options.grade).length === 0 && options.grade !== undefined || values(options.actor).length === 0 && options.actor !== undefined || options.path?.trim() === '' || options.command?.trim() === '') {
		writeLine(context.stderr, 'Watch filters must be non-empty; --after-sequence and --interval-ms must be non-negative integers.');
		return ExitCode.InvalidInvocation;
	}
	let cursor = afterSequence;
	const collected: SessionEvent[] = [];
	const printed = new Set<string>();
	if (context.format === 'pretty') {
		writeLine(context.stdout, `Watching session ${sessionId} from sequence ${cursor + 1}`);
		for (;;) {
			const outcome = await requestSupervisor<unknown>(context, `/v1/sessions/${encodeURIComponent(sessionId)}/log`);
			if (outcome.kind === 'error') { writeLine(context.stderr, outcome.message); return ExitCode.Unavailable; }
			const parsed = ActivityLogSchema.safeParse(outcome.data);
			if (!parsed.success || parsed.data.sessionId !== sessionId) { writeLine(context.stderr, 'Supervisor returned an invalid activity log.'); return ExitCode.Internal; }
			const snapshot = parsed.data;
			const terminal = options.once || snapshot.state !== 'running';
			const visible = snapshot.entries.filter((entry) => entry.category !== 'usage');
			const entries = terminal ? snapshot.entries : visible.slice(0, -1);
			for (const entry of entries) {
				if (printed.has(entry.id) || (!terminal && entry.status === 'running') || !entry.sources.some((source) => (source.sequence ?? 0) > afterSequence)) { continue; }
				if (values(options.kind).length > 0 && !entry.sources.some((source) => values(options.kind).includes(source.kind))) { continue; }
				if (values(options.grade).length > 0 && !entry.sources.some((source) => values(options.grade).includes(source.evidenceGrade))) { continue; }
				if (values(options.actor).length > 0 && !values(options.actor).includes(entry.actor)) { continue; }
				if (options.path !== undefined && !entry.resources.some((resource) => resource.path.includes(options.path ?? ''))) { continue; }
				if (options.command !== undefined && !entry.title.includes(options.command)) { continue; }
				for (const line of formatActivityText(entry)) { writeLine(context.stdout, line); }
				printed.add(entry.id);
			}
			if (terminal) { return ExitCode.Ok; }
			await delay(intervalMs);
		}
	}

	for (;;) {
		const outcome = await requestSupervisor<EventsResult>(context, queryPath(sessionId, cursor, options));
		if (outcome.kind === 'error') {
			writeLine(context.stderr, outcome.message);
			return ExitCode.Unavailable;
		}
		const snapshot = outcome.data;
		for (const event of snapshot.events) {
			collected.push(event);
			if (context.format === 'jsonl') {
				writeJsonLine(context.stdout, event);
			}
		}
		cursor = snapshot.cursor?.nextSequence ?? cursor;
		if (options.once || snapshot.terminal) {
			if (context.format === 'json') {
				writeJson(context.stdout, { schemaVersion: 1, command: 'watch', result: { sessionId, events: collected, cursor: { nextSequence: cursor }, terminal: snapshot.terminal ?? false } });
			}
			return ExitCode.Ok;
		}
		await delay(intervalMs);
	}
}