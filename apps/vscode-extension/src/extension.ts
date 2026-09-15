import * as vscode from 'vscode';

import { LogDetailsView } from './logDetailsView';
import { logDownloadFileName, presentSession } from './sessionPresentation';
import { SidebarLogView, type SidebarLogItem } from './sidebarLogView';
import { deleteSession, getEvidenceBundle, getSessionEventSnapshot, listSessions, parseCommandArray, startCodexSession, startManagedRun, trustWorkspace, type SupervisorSession } from './supervisorApi';
import { describeConnection, type SupervisorConnection } from './supervisorClient';
import { SupervisorRuntime } from './supervisorRuntime';

const SESSION_REFRESH_INTERVAL_MS = 1_000;
const SELECTED_LOG_REFRESH_INTERVAL_MS = 150;

interface ActiveLogFollower {
	readonly sessionId: string;
	readonly controller: AbortController;
}

interface LogFollowerState {
	active: ActiveLogFollower | undefined;
}

export function activate(context: vscode.ExtensionContext): void {
	const sessionView = new SidebarLogView();
	const detailsView = new LogDetailsView();
	const treeView = vscode.window.createTreeView<SidebarLogItem>('model-worklog.sessions', {
		treeDataProvider: sessionView,
		showCollapseAll: true,
	});
	const supervisorRuntime = new SupervisorRuntime({ extensionPath: context.extensionPath });
	const followerState: LogFollowerState = { active: undefined };
	let refreshInFlight = false;
	const refreshTimer = setInterval(() => {
		if (!sessionView.isLoggerEnabled() || refreshInFlight) {
			return;
		}
		const url = configuredSupervisorUrl(false);
		if (url === undefined) {
			return;
		}
		refreshInFlight = true;
		void refreshSessions(url, sessionView, false)
			.then((sessions) => updateSelectedDetails(detailsView, sessions))
			.finally(() => {
				refreshInFlight = false;
			});
	}, SESSION_REFRESH_INTERVAL_MS);

	context.subscriptions.push(
		sessionView,
		treeView,
		vscode.window.registerWebviewViewProvider('model-worklog.logDetails', detailsView, { webviewOptions: { retainContextWhenHidden: true } }),
		{ dispose: () => {
			clearInterval(refreshTimer);
			followerState.active?.controller.abort();
			detailsView.clear();
		} },
		vscode.commands.registerCommand('model-worklog.enable', async () => {
			if (!requireTrustedWorkspace()) {
				return;
			}
			await enableLogger(supervisorRuntime, sessionView, detailsView, true);
		}),
		vscode.commands.registerCommand('model-worklog.disable', () => {
			followerState.active?.controller.abort();
			followerState.active = undefined;
			detailsView.clear();
			sessionView.setLoggerState(false, 'disabled', 'Activity is hidden in this VS Code window. Existing agent sessions keep running safely.');
			vscode.window.showInformationMessage('Model Logger is disabled in this VS Code window.');
		}),
		vscode.commands.registerCommand('model-worklog.reconnect', async () => {
			if (!requireTrustedWorkspace()) {
				return;
			}
			await enableLogger(supervisorRuntime, sessionView, detailsView, false);
		}),
		vscode.commands.registerCommand('model-worklog.refreshSessions', async () => {
			if (!sessionView.isLoggerEnabled()) {
				vscode.window.showInformationMessage('Enable Logger to refresh activity.');
				return;
			}
			const url = configuredSupervisorUrl();
			if (url !== undefined) {
				await refreshSessions(url, sessionView, true);
			}
		}),
		vscode.commands.registerCommand('model-worklog.startCodexSession', async () => {
			if (!requireTrustedWorkspace() || !await enableLogger(supervisorRuntime, sessionView, detailsView, false)) {
				return;
			}
			const workspacePath = activeWorkspacePath();
			const url = configuredSupervisorUrl();
			if (workspacePath === undefined || url === undefined) {
				return;
			}
			const task = await vscode.window.showInputBox({
				title: 'Log a Codex Task',
				prompt: 'Task for Codex',
				ignoreFocusOut: true,
				validateInput: (value) => value.trim() === '' ? 'Enter a task for Codex.' : value.length > 32_000 ? 'Task must be at most 32,000 characters.' : undefined,
			});
			if (task === undefined) {
				return;
			}
			try {
				const session = await startCodexSession(url, workspacePath, task, {
					maxDurationMs: configuredCodexDurationMinutes() * 60 * 1_000,
					maxTokens: configuredCodexTokenBudget(),
				});
				await refreshSessions(url, sessionView, false);
				vscode.window.showInformationMessage(`Codex activity is now being recorded. Select View Log under Live Activity for ${session.sessionId}.`);
			} catch (error) {
				vscode.window.showWarningMessage(`Could not start Codex logging: ${message(error)}`);
			}
		}),
		vscode.commands.registerCommand('model-worklog.startLoggedCommand', async () => {
			if (!requireTrustedWorkspace() || !await enableLogger(supervisorRuntime, sessionView, detailsView, false)) {
				return;
			}
			const workspacePath = activeWorkspacePath();
			const url = configuredSupervisorUrl();
			if (workspacePath === undefined || url === undefined) {
				return;
			}
			const input = await vscode.window.showInputBox({ title: 'Log a Command', prompt: 'Command as a JSON string array', value: '["npm", "test"]' });
			if (input === undefined) {
				return;
			}
			const command = parseCommandArray(input);
			if (command === undefined) {
				vscode.window.showWarningMessage('Enter a non-empty JSON array of command strings.');
				return;
			}
			try {
				const session = await startManagedRun(url, workspacePath, command[0]!, command.slice(1));
				await refreshSessions(url, sessionView, false);
				vscode.window.showInformationMessage(`Command activity is now being recorded. Select View Log under Live Activity for ${session.sessionId}.`);
			} catch (error) {
				vscode.window.showWarningMessage(`Could not start command logging: ${message(error)}`);
			}
		}),
		vscode.commands.registerCommand('model-worklog.openSessionLog', async (sessionId: string) => {
			if (!sessionView.isLoggerEnabled()) {
				vscode.window.showInformationMessage('Enable Logger to view activity.');
				return;
			}
			const url = configuredSupervisorUrl();
			if (url === undefined) {
				return;
			}
			await viewLogInDetails(sessionView, detailsView, url, sessionId, followerState);
		}),
		vscode.commands.registerCommand('model-worklog.exportEvidenceBundle', async (requestedSessionId?: string) => {
			if (!sessionView.isLoggerEnabled()) {
				vscode.window.showInformationMessage('Enable Logger to download activity.');
				return;
			}
			const url = configuredSupervisorUrl();
			if (url === undefined) {
				return;
			}
			try {
				const sessions = await listSessions(url);
				const selectedSession = requestedSessionId === undefined
					? (await vscode.window.showQuickPick(sessions.map((session) => ({ label: presentSession(session).title, description: presentSession(session).description, detail: session.sessionId, session })), { title: 'Download JSON Log', placeHolder: 'Select a log' }))?.session
					: sessions.find((session) => session.sessionId === requestedSessionId);
				if (selectedSession === undefined) {
					return;
				}
				const destination = await vscode.window.showSaveDialog({ title: 'Download JSON Log', defaultUri: vscode.Uri.file(logDownloadFileName(selectedSession)), filters: { 'JSON': ['json'] } });
				if (destination === undefined) {
					return;
				}
				const bundle = await getEvidenceBundle(url, selectedSession.sessionId);
				await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(`${JSON.stringify(bundle, null, 2)}\n`));
				vscode.window.showInformationMessage(`Downloaded ${presentSession(selectedSession).title} as JSON.`);
			} catch (error) {
				vscode.window.showWarningMessage(`Could not download JSON: ${message(error)}`);
			}
		}),
		vscode.commands.registerCommand('model-worklog.deleteSession', async (requestedSessionId?: string) => {
			if (!sessionView.isLoggerEnabled()) {
				vscode.window.showInformationMessage('Enable Logger to delete saved activity.');
				return;
			}
			const url = configuredSupervisorUrl();
			if (url === undefined) {
				return;
			}
			try {
				const sessions = await refreshSessions(url, sessionView, false);
				const finished = sessions.filter((session) => session.state !== 'running');
				const selected = requestedSessionId === undefined
					? await vscode.window.showQuickPick(finished.map((session) => ({ label: session.sessionId, description: 'Delete this saved log permanently', sessionId: session.sessionId })), { title: 'Delete Saved Log', placeHolder: 'Select a finished log' })
					: { sessionId: requestedSessionId };
				if (selected === undefined) {
					return;
				}
				if (!finished.some((session) => session.sessionId === selected.sessionId)) {
					vscode.window.showWarningMessage('Only finished logs can be deleted.');
					return;
				}
				const answer = await vscode.window.showWarningMessage('Delete this saved log permanently?', { modal: true, detail: 'This removes the local activity record and its JSON download data.' }, 'Delete Log');
				if (answer !== 'Delete Log') {
					return;
				}
				if (followerState.active?.sessionId === selected.sessionId) {
					followerState.active.controller.abort();
					followerState.active = undefined;
				}
				await deleteSession(url, selected.sessionId);
				detailsView.clear(selected.sessionId);
				await refreshSessions(url, sessionView, false);
				vscode.window.showInformationMessage('Saved log deleted.');
			} catch (error) {
				vscode.window.showWarningMessage(`Could not delete log: ${message(error)}`);
			}
		}),
	);
}

function requireTrustedWorkspace(): boolean {
	if (vscode.workspace.isTrusted) {
		return true;
	}
	vscode.window.showWarningMessage('Trust this workspace before starting Logger processes.');
	return false;
}

async function enableLogger(runtime: SupervisorRuntime, sessionView: SidebarLogView, detailsView: LogDetailsView, announce: boolean): Promise<boolean> {
	const workspacePath = activeWorkspacePath();
	const url = configuredSupervisorUrl();
	if (workspacePath === undefined || url === undefined) {
		return false;
	}
	try {
		const connection = await runtime.ensureRunning(url);
		const { label, detail } = describeConnection(connection);
		sessionView.setLoggerState(connection.kind === 'connected', label, detail);
		if (connection.kind !== 'connected') {
			reportConnection(connection);
			return false;
		}
		await trustWorkspace(url, workspacePath);
		const sessions = await refreshSessions(url, sessionView, false);
		updateSelectedDetails(detailsView, sessions);
		if (announce) {
			vscode.window.showInformationMessage('Model Logger is enabled in this VS Code window.');
		}
		return true;
	} catch (error) {
		const detail = message(error);
		sessionView.setLoggerState(false, 'unavailable', detail);
		vscode.window.showWarningMessage(`Could not enable Logger: ${detail}`);
		return false;
	}
}

function configuredSupervisorUrl(announce = true): URL | undefined {
	const configuredUrl = vscode.workspace.getConfiguration('model-worklog').get<string>('supervisorUrl');
	if (!configuredUrl) {
		if (announce) {
			vscode.window.showWarningMessage('No local Logger URL is configured.');
		}
		return undefined;
	}
	try {
		const url = new URL(configuredUrl);
		const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
		if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
			if (announce) {
				vscode.window.showWarningMessage(`Logger URL must be loopback HTTP, received ${url.origin}.`);
			}
			return undefined;
		}
		if (host === 'localhost') {
			url.hostname = '127.0.0.1';
		}
		if (url.port === '') {
			url.port = '43199';
		}
		return url;
	} catch {
		if (announce) {
			vscode.window.showWarningMessage(`Invalid Logger URL: ${configuredUrl}`);
		}
		return undefined;
	}
}

function activeWorkspacePath(): string | undefined {
	const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
	if (workspacePath === undefined) {
		vscode.window.showWarningMessage('Open a workspace folder before using Model Logger.');
	}
	return workspacePath;
}

function configuredCodexDurationMinutes(): number {
	const value = vscode.workspace.getConfiguration('model-worklog').get<number>('codex.defaultDurationMinutes', 30);
	return Number.isInteger(value) && value >= 1 && value <= 240 ? value : 30;
}

function configuredCodexTokenBudget(): number {
	const value = vscode.workspace.getConfiguration('model-worklog').get<number>('codex.defaultTokenBudget', 50_000);
	return Number.isInteger(value) && value >= 1 && value <= 2_000_000 ? value : 50_000;
}

async function refreshSessions(url: URL, sessionView: SidebarLogView, announce: boolean): Promise<readonly SupervisorSession[]> {
	try {
		const sessions = await listSessions(url);
		sessionView.setSessions(sessions);
		if (announce) {
			vscode.window.showInformationMessage(`Loaded ${sessions.length} log${sessions.length === 1 ? '' : 's'}.`);
		}
		return sessions;
	} catch (error) {
		if (announce) {
			vscode.window.showWarningMessage(`Could not load activity: ${message(error)}`);
		}
		return [];
	}
}

function updateSelectedDetails(detailsView: LogDetailsView, sessions: readonly SupervisorSession[]): void {
	const selectedSessionId = detailsView.selectedSessionId;
	if (selectedSessionId === undefined) {
		return;
	}
	const selected = sessions.find((session) => session.sessionId === selectedSessionId);
	if (selected !== undefined) {
		detailsView.updateSession(selected);
	}
}

async function viewLogInDetails(sessionView: SidebarLogView, detailsView: LogDetailsView, url: URL, sessionId: string, followerState: LogFollowerState): Promise<void> {
	let session = sessionView.getSession(sessionId);
	if (session === undefined) {
		const sessions = await refreshSessions(url, sessionView, false);
		session = sessions.find((candidate) => candidate.sessionId === sessionId);
	}
	if (session === undefined) {
		throw new Error('This log is no longer available.');
	}
	if (followerState.active?.sessionId === sessionId) {
		await detailsView.show();
		return;
	}
	followerState.active?.controller.abort();
	await detailsView.select(session);
	const controller = new AbortController();
	followerState.active = { sessionId, controller };
	void followSelectedLog(url, sessionId, session, detailsView, controller.signal)
		.catch((error: unknown) => {
			if (!controller.signal.aborted) {
				vscode.window.showWarningMessage(`Could not view log: ${message(error)}`);
			}
		})
		.finally(() => {
			if (followerState.active?.controller === controller) {
				followerState.active = undefined;
			}
		});
}

async function followSelectedLog(url: URL, sessionId: string, initialSession: SupervisorSession, detailsView: LogDetailsView, signal: AbortSignal): Promise<void> {
	let afterSequence = 0;
	let session = initialSession;
	while (!signal.aborted) {
		const snapshot = await getSessionEventSnapshot(url, sessionId, { afterSequence });
		if (signal.aborted) {
			return;
		}
		detailsView.append(session, snapshot.events);
		afterSequence = snapshot.cursor.nextSequence;
		if (snapshot.terminal) {
			const sessions = await listSessions(url);
			session = sessions.find((candidate) => candidate.sessionId === sessionId) ?? session;
			detailsView.updateSession(session);
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, SELECTED_LOG_REFRESH_INTERVAL_MS));
	}
}

function reportConnection(connection: SupervisorConnection): void {
	switch (connection.kind) {
		case 'connected':
			return;
		case 'incompatible':
			vscode.window.showWarningMessage(`Logger API ${connection.health.apiVersion} is incompatible with this extension.`);
			return;
		case 'http-error':
		case 'malformed':
			vscode.window.showWarningMessage('The local Logger responded but could not be verified.');
			return;
		case 'unreachable':
			vscode.window.showWarningMessage('Model Logger is unavailable.');
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function deactivate() {}