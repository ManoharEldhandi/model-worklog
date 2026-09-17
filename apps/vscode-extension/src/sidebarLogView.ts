import * as vscode from 'vscode';

import { presentSession } from './sessionPresentation';
import type { SupervisorSession } from './supervisorApi';

export type SidebarLogAction = 'enable' | 'disable' | 'start-codex' | 'start-copilot' | 'start-copilot-interactive' | 'stop-log' | 'view-log' | 'download-json' | 'delete-log';

export interface SessionSidebarItem {
	readonly kind: 'session';
	readonly sessionId: string;
}

export type SidebarLogItem =
	| { readonly kind: 'connection' }
	| { readonly kind: 'action'; readonly action: SidebarLogAction; readonly sessionId?: string }
	| { readonly kind: 'group'; readonly group: 'live' | 'previous' }
	| SessionSidebarItem;

/** Compact native list of saved logs. Selected content is shown in the detail panel. */
export class SidebarLogView implements vscode.TreeDataProvider<SidebarLogItem>, vscode.Disposable {
	private readonly changeEmitter = new vscode.EventEmitter<SidebarLogItem | undefined>();
	private readonly sessions = new Map<string, SupervisorSession>();
	private readonly sessionItems = new Map<string, SessionSidebarItem>();
	private readonly groupItems: Readonly<Record<'live' | 'previous', Extract<SidebarLogItem, { readonly kind: 'group' }>>> = {
		live: { kind: 'group', group: 'live' },
		previous: { kind: 'group', group: 'previous' },
	};
	private loggerEnabled = false;
	private loggerLabel = 'disabled';
	private loggerDetail = 'Enable Logger to view activity from supported AI integrations in this workspace.';

	readonly onDidChangeTreeData: vscode.Event<SidebarLogItem | undefined> = this.changeEmitter.event;

	getParent(item: SidebarLogItem): SidebarLogItem | undefined {
		if (item.kind === 'session') {
			const session = this.sessions.get(item.sessionId);
			return session?.state === 'running' ? this.groupItems.live : session === undefined ? undefined : this.groupItems.previous;
		}
		if (item.kind === 'action' && item.sessionId !== undefined) {
			return this.sessionItem(item.sessionId);
		}
		return undefined;
	}

	getTreeItem(item: SidebarLogItem): vscode.TreeItem {
		switch (item.kind) {
			case 'connection':
				return this.item(`Logger: ${this.loggerLabel}`, this.loggerEnabled ? 'plug' : 'debug-disconnect', vscode.TreeItemCollapsibleState.None, undefined, this.loggerDetail);
			case 'action':
				return this.actionItem(item);
			case 'group': {
				const count = this.groupSessions(item.group).length;
				return this.item(item.group === 'live' ? 'Live Activity' : 'Previous Activity', item.group === 'live' ? 'broadcast' : 'history', vscode.TreeItemCollapsibleState.Expanded, undefined, `${count} log${count === 1 ? '' : 's'}`, String(count));
			}
			case 'session': {
				const session = this.sessions.get(item.sessionId);
				if (session === undefined) {
					return this.item('Log no longer available', 'error', vscode.TreeItemCollapsibleState.None);
				}
				const presentation = presentSession(session);
				return this.item(presentation.title, presentation.icon, vscode.TreeItemCollapsibleState.Collapsed, 'model-worklog.openSessionLog', presentation.tooltip, presentation.description, [item.sessionId]);
			}
		}
	}

	getChildren(item?: SidebarLogItem): SidebarLogItem[] {
		if (item === undefined) {
			return this.loggerEnabled
				? [
					{ kind: 'connection' },
					{ kind: 'action', action: 'disable' },
					{ kind: 'action', action: 'start-codex' },
					{ kind: 'action', action: 'start-copilot' },
					{ kind: 'action', action: 'start-copilot-interactive' },
					this.groupItems.live,
					this.groupItems.previous,
				]
				: [{ kind: 'connection' }, { kind: 'action', action: 'enable' }];
		}
		if (item.kind === 'group') {
			return this.groupSessions(item.group).map((session) => this.sessionItem(session.sessionId));
		}
		if (item.kind === 'session') {
			const session = this.sessions.get(item.sessionId);
			if (session === undefined) {
				return [];
			}
			return [
				...(session.state === 'running' ? [{ kind: 'action' as const, action: 'stop-log' as const, sessionId: item.sessionId }] : []),
				{ kind: 'action', action: 'view-log', sessionId: item.sessionId },
				{ kind: 'action', action: 'download-json', sessionId: item.sessionId },
				...(session.state === 'running' ? [] : [{ kind: 'action' as const, action: 'delete-log' as const, sessionId: item.sessionId }]),
			];
		}
		return [];
	}

	setLoggerState(enabled: boolean, label: string, detail: string): void {
		const changed = this.loggerEnabled !== enabled || this.loggerLabel !== label || this.loggerDetail !== detail;
		this.loggerEnabled = enabled;
		this.loggerLabel = label;
		this.loggerDetail = detail;
		if (!enabled) {
			this.sessions.clear();
			this.sessionItems.clear();
		}
		if (changed) {
			this.changeEmitter.fire(undefined);
		}
	}

	isLoggerEnabled(): boolean {
		return this.loggerEnabled;
	}

	setSessions(sessions: readonly SupervisorSession[]): void {
		const visibleSessions = sessions.filter((session) => session.actor !== 'workspace-observer' && session.actor !== 'vscode-terminal');
		const changed = !sameSessions(this.sessions, visibleSessions);
		this.sessions.clear();
		for (const session of visibleSessions) {
			this.sessions.set(session.sessionId, session);
		}
		for (const sessionId of this.sessionItems.keys()) {
			if (!this.sessions.has(sessionId)) {
				this.sessionItems.delete(sessionId);
			}
		}
		if (changed) {
			this.changeEmitter.fire(undefined);
		}
	}

	getSession(sessionId: string): SupervisorSession | undefined {
		return this.sessions.get(sessionId);
	}

	sessionItem(sessionId: string): SessionSidebarItem {
		let item = this.sessionItems.get(sessionId);
		if (item === undefined) {
			item = { kind: 'session', sessionId };
			this.sessionItems.set(sessionId, item);
		}
		return item;
	}

	dispose(): void {
		this.changeEmitter.dispose();
	}

	private groupSessions(group: 'live' | 'previous'): readonly SupervisorSession[] {
		return [...this.sessions.values()].filter((session) => group === 'live' ? session.state === 'running' : session.state !== 'running');
	}

	private actionItem(action: Extract<SidebarLogItem, { readonly kind: 'action' }>): vscode.TreeItem {
		const actions: Record<SidebarLogAction, { readonly label: string; readonly icon: string; readonly command: string; readonly tooltip: string }> = {
			enable: { label: 'Enable Logger', icon: 'play', command: 'model-worklog.enable', tooltip: 'Connect this VS Code window to the local Logger.' },
			disable: { label: 'Disable Logger', icon: 'debug-disconnect', command: 'model-worklog.disable', tooltip: 'Stop agent logging in this VS Code window. Active agent sessions continue safely.' },
			'start-codex': { label: 'Log a Codex Task', icon: 'run-all', command: 'model-worklog.startCodexSession', tooltip: 'Launch Codex with Logger activity tracking.' },
			'start-copilot': { label: 'Log a Copilot CLI Task', icon: 'hubot', command: 'model-worklog.startCopilotSession', tooltip: 'Launch Copilot CLI with documented agent-event and token logging.' },
			'start-copilot-interactive': { label: 'Start Interactive Copilot CLI', icon: 'terminal', command: 'model-worklog.startCopilotInteractiveSession', tooltip: 'Open an interactive Copilot CLI terminal with activity and final token logging.' },
			'stop-log': { label: 'Stop Log', icon: 'debug-stop', command: 'model-worklog.stopLiveLog', tooltip: 'Stop recording this live log. Logger-managed tasks are interrupted; interactive Copilot CLI sessions continue without recording.' },
			'view-log': { label: 'View Log', icon: 'list-tree', command: 'model-worklog.openSessionLog', tooltip: 'Show this log in the bottom Logger panel.' },
			'download-json': { label: 'Download JSON', icon: 'export', command: 'model-worklog.exportEvidenceBundle', tooltip: 'Download this log as redacted JSON.' },
			'delete-log': { label: 'Delete Log', icon: 'trash', command: 'model-worklog.deleteSession', tooltip: 'Permanently delete this finished log.' },
		};
		const detail = actions[action.action];
		return this.item(detail.label, detail.icon, vscode.TreeItemCollapsibleState.None, detail.command, detail.tooltip, undefined, action.sessionId === undefined ? undefined : [action.sessionId]);
	}

	private item(label: string, icon: string, collapsibleState: vscode.TreeItemCollapsibleState, command?: string, tooltip?: string, description?: string, argumentsValue?: readonly unknown[]): vscode.TreeItem {
		const item = new vscode.TreeItem(label, collapsibleState);
		item.iconPath = new vscode.ThemeIcon(icon);
		if (description !== undefined) {
			item.description = description;
		}
		if (tooltip !== undefined) {
			item.tooltip = tooltip;
		}
		if (command !== undefined) {
			item.command = { command, title: label, ...(argumentsValue === undefined ? {} : { arguments: [...argumentsValue] }) };
		}
		return item;
	}
}

function sameSessions(previous: ReadonlyMap<string, SupervisorSession>, current: readonly SupervisorSession[]): boolean {
	if (previous.size !== current.length) {
		return false;
	}
	return current.every((session) => {
		const existing = previous.get(session.sessionId);
		return existing !== undefined
			&& existing.state === session.state
			&& existing.runMode === session.runMode
			&& existing.actor === session.actor
			&& existing.eventCount === session.eventCount
			&& JSON.stringify(existing.tokenUsage) === JSON.stringify(session.tokenUsage);
	});
}
