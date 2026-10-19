import { buildSessionLog, formatActivityText, type ActivityEntry, type ActivityStatus, type ActivityLog, type SessionEvent } from 'model-worklog-schema';

import type { SupervisorSession } from './supervisorApi';

export interface LogDetailEntry {
	readonly id?: string;
	readonly label: string;
	readonly content?: string;
	readonly timestamp?: string;
	readonly endedAt?: string;
	readonly status?: ActivityStatus;
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
	readonly activity: readonly ActivityEntry[];
	readonly log: ActivityLog;
	readonly sections: readonly LogDetailSection[];
}

const MAX_SECTION_ENTRIES = 100;

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

/** Builds one readable, sectioned view of a selected session's saved activity. */
export function buildLogDetail(session: SupervisorSession, events: readonly SessionEvent[]): LogDetailModel {
	return buildLogDetailFromLog({ ...session, title: session.title ?? titleFromEvents(events) }, buildSessionLog(events, {
		sessionId: session.sessionId, ...(session.state === 'running' || session.state === 'completed' || session.state === 'failed' || session.state === 'interrupted' ? { state: session.state } : {}),
	}));
}

export function buildLogDetailFromLog(session: SupervisorSession, log: ActivityLog): LogDetailModel {
	if (session.sessionId !== log.sessionId) { throw new Error('Log does not match the selected session.'); }
	const activity = log.entries;
	return {
		sessionId: session.sessionId,
		title: session.title ?? title(session),
		status: status({ ...session, state: log.state }),
		updateCount: log.sourceCount,
		activity, log,
		sections: [
			section('Activity', activity.map((entry) => ({ id: entry.id, label: entry.title,
				timestamp: entry.startedAt, endedAt: entry.endedAt, status: entry.status,
				content: formatActivityText(entry).slice(1).join('\n') || undefined }))),
		].filter((value): value is LogDetailSection => value !== undefined),
	};
}