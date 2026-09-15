import { setTimeout as delay } from 'node:timers/promises';

import type { EventKind, SessionEvent } from 'model-worklog-schema';

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

function subject(event: SessionEvent): string {
	const payload = event.payload as Record<string, unknown>;
	if (typeof payload.summary === 'string') {
		return payload.summary.replace(/[\r\n]+/g, ' ').slice(0, 120);
	}
	if (typeof payload.text === 'string') {
		return payload.text.replace(/[\r\n]+/g, ' ').slice(0, 120);
	}
	if (typeof payload.executable === 'string') {
		const args = Array.isArray(payload.args) ? payload.args.filter((value): value is string => typeof value === 'string') : [];
		return [payload.executable, ...args].join(' ').slice(0, 120);
	}
	if (typeof payload.path === 'string') {
		return payload.path.slice(0, 120);
	}
	return JSON.stringify(payload).replace(/[\r\n]+/g, ' ').slice(0, 120);
}

function writePrettyEvent(context: CommandContext, event: SessionEvent): void {
	writeLine(context.stdout, `${String(event.sequence).padEnd(4)} ${event.occurredAt.slice(11, 23).padEnd(13)} ${event.evidenceGrade.padEnd(18)} ${event.actor.padEnd(12)} ${event.kind.padEnd(20)} ${subject(event)}`);
	if (event.unknownReason !== undefined) {
		writeLine(context.stdout, `     evidence gap: ${event.unknownReason}`);
	}
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
	if (context.format === 'pretty') {
		writeLine(context.stdout, `Watching session ${sessionId} from sequence ${cursor + 1}`);
		writeLine(context.stdout, 'SEQ  TIME          GRADE              ACTOR        KIND                 SUBJECT');
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
			if (context.format === 'pretty') {
				writePrettyEvent(context, event);
			} else if (context.format === 'jsonl') {
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