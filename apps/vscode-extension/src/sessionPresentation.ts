import type { SupervisorSession } from './supervisorApi';

export interface SessionPresentation {
	readonly title: string;
	readonly description: string;
	readonly tooltip: string;
	readonly icon: 'sync~spin' | 'pass' | 'error' | 'debug-stop';
}

function sourceLabel(session: SupervisorSession): string {
	if (session.actor === 'codex-app-server') {
		return 'Codex';
	}
	if (session.actor === 'copilot-cli') {
		return 'Copilot CLI';
	}
	if (session.actor === 'copilot-cli-interactive') {
		return 'Copilot CLI (interactive)';
	}
	if (session.runMode === 'managed') {
		return 'CLI boundary';
	}
	return session.actor;
}

function captureDetail(session: SupervisorSession): string {
	if (session.actor === 'codex-app-server') {
		return 'Capture: documented Codex App Server activity observed by the supervisor.';
	}
	if (session.actor === 'copilot-cli') {
		return 'Capture: documented Copilot CLI messages, tool activity, results, and provider-reported usage observed by the supervisor.';
	}
	if (session.actor === 'copilot-cli-interactive') {
		return 'Capture: documented Copilot CLI hook activity plus final provider-reported usage from local metadata-only telemetry.';
	}
	if (session.runMode === 'managed') {
		return 'Capture: process lifecycle, bounded output, and workspace diff only; no internal agent activity.';
	}
	return 'Capture: activity reported by the agent integration.';
}

function slug(value: string): string {
	const cleaned = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return cleaned === '' ? 'model-logger-log' : cleaned.slice(0, 72).replace(/-+$/g, '');
}

function stateLabel(state: string): string {
	switch (state) {
		case 'running':
			return 'Live';
		case 'completed':
			return 'Completed';
		case 'failed':
			return 'Failed';
		case 'interrupted':
			return 'Stopped';
		default:
			return state;
	}
}

function stateIcon(state: string): SessionPresentation['icon'] {
	switch (state) {
		case 'running':
			return 'sync~spin';
		case 'completed':
			return 'pass';
		case 'failed':
			return 'error';
		default:
			return 'debug-stop';
	}
}

export function tokenUsageLabel(session: SupervisorSession): string {
	if (session.tokenUsage.status === 'reported') {
		return `${session.tokenUsage.totalTokens.toLocaleString()} tokens`;
	}
	return session.state === 'running' ? 'not reported yet' : 'not reported';
}

export function presentSession(session: SupervisorSession): SessionPresentation {
	const source = sourceLabel(session);
	const taskTitle = session.title ?? `${source} log`;
	const state = stateLabel(session.state);
	const tokenUsage = tokenUsageLabel(session);
	const updates = `${session.eventCount} update${session.eventCount === 1 ? '' : 's'}`;
	return {
		title: taskTitle,
		description: `${state} · ${updates}${session.tokenUsage.status === 'reported' ? ` · ${tokenUsage}` : ''}`,
		tooltip: `${taskTitle}\n${session.sessionId}\n${source} · ${state} · ${session.runMode} · ${updates}\n${captureDetail(session)}\nToken count: ${tokenUsage}${session.tokenUsage.status === 'reported' ? '' : '\nToken counts appear only when the AI provider or integration reports them.'}`,
		icon: stateIcon(session.state),
	};
}

/** Creates a readable and filesystem-safe JSON download name for a saved log. */
export function logDownloadFileName(session: SupervisorSession): string {
	return `${slug(session.title ?? sourceLabel(session))}-${session.sessionId.slice(-8)}.json`;
}