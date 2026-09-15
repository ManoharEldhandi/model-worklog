import * as vscode from 'vscode';

import { formatSessionEvent } from './eventPresentation';
import { cancelSession, getEvidenceBundle, getSessionEventSnapshot, listSessions, parseCommandArray, startCodexSession, startManagedRun, trustWorkspace, type SupervisorSession } from './supervisorApi';
import { describeConnection, type SupervisorConnection } from './supervisorClient';
import { SupervisorRuntime } from './supervisorRuntime';

class LoggerSessionsView implements vscode.TreeDataProvider<vscode.TreeItem> {
	private readonly changeEmitter = new vscode.EventEmitter<void>();
	private supervisorLabel = 'not enabled';
	private supervisorDetail = 'Enable Model Logger to start or reconnect the local logger.';
	private sessions: readonly SupervisorSession[] = [];

	readonly onDidChangeTreeData = this.changeEmitter.event;

	getTreeItem(item: vscode.TreeItem): vscode.TreeItem {
		return item;
	}

	getChildren(): vscode.TreeItem[] {
		return [
			this.item(`Model Logger: ${this.supervisorLabel}`, 'pulse', 'model-worklog.enable', this.supervisorDetail),
			this.item('Log a Codex Session', 'run-all', 'model-worklog.startCodexSession', 'Launch Codex through the bundled local logger.'),
			this.item('Log a Command', 'play', 'model-worklog.startLoggedCommand', 'Record a trusted command with redacted output and a Git snapshot.'),
			this.item('Stop Active Session', 'debug-stop', 'model-worklog.stopSession', 'Interrupt a running supervisor-managed Codex session.'),
			this.item('Refresh Logs', 'refresh', 'model-worklog.refreshSessions'),
			...this.sessions.map((session) => this.item(
				`${session.sessionId.slice(0, 20)} · ${session.state} · ${session.eventCount} events · ${formatTokenUsage(session)}`,
				'symbol-event',
				'model-worklog.openSessionLog',
				`${session.runMode} session by ${session.actor}`,
				[session.sessionId],
			)),
		];
	}

	setSupervisor(label: string, detail: string): void {
		this.supervisorLabel = label;
		this.supervisorDetail = detail;
		this.changeEmitter.fire();
	}

	setSessions(sessions: readonly SupervisorSession[]): void {
		this.sessions = sessions;
		this.changeEmitter.fire();
	}

	private item(label: string, icon: string, command?: string, tooltip?: string, argumentsValue?: readonly unknown[]): vscode.TreeItem {
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		item.iconPath = new vscode.ThemeIcon(icon);
		if (tooltip !== undefined) {
			item.tooltip = tooltip;
		}
		if (command !== undefined) {
			item.command = { command, title: label, ...(argumentsValue === undefined ? {} : { arguments: [...argumentsValue] }) };
		}
		return item;
	}
}

export function activate(context: vscode.ExtensionContext): void {
	const output = vscode.window.createOutputChannel('Model Logger');
	const sessionView = new LoggerSessionsView();
	const supervisorRuntime = new SupervisorRuntime({ extensionPath: context.extensionPath });

	context.subscriptions.push(
		output,
		vscode.window.registerTreeDataProvider('model-worklog.sessions', sessionView),
		vscode.commands.registerCommand('model-worklog.enable', async () => {
			if (!requireTrustedWorkspace()) {
				return;
			}
			await enableSupervisor(supervisorRuntime, sessionView, output, true);
		}),
		vscode.commands.registerCommand('model-worklog.reconnect', async () => {
			if (!requireTrustedWorkspace()) {
				return;
			}
			await enableSupervisor(supervisorRuntime, sessionView, output, false);
		}),
		vscode.commands.registerCommand('model-worklog.refreshSessions', async () => {
			if (!await enableSupervisor(supervisorRuntime, sessionView, output, false)) {
				return;
			}
			await refreshSessions(sessionView, output);
		}),
		vscode.commands.registerCommand('model-worklog.startCodexSession', async () => {
			if (!requireTrustedWorkspace() || !await enableSupervisor(supervisorRuntime, sessionView, output, false)) {
				return;
			}
			const workspacePath = activeWorkspacePath();
			const url = configuredSupervisorUrl();
			if (workspacePath === undefined || url === undefined) {
				return;
			}
			const task = await vscode.window.showInputBox({
				title: 'Log a Codex Session',
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
				vscode.window.showInformationMessage(`Logging Codex session ${session.sessionId}.`);
				await refreshSessions(sessionView, output);
				void followSessionLog(url, session.sessionId, sessionView, output).catch((error: unknown) => vscode.window.showWarningMessage(`Could not follow Codex session: ${message(error)}`));
			} catch (error) {
				vscode.window.showWarningMessage(`Could not start Codex session: ${message(error)}`);
			}
		}),
		vscode.commands.registerCommand('model-worklog.startLoggedCommand', async () => {
			if (!requireTrustedWorkspace() || !await enableSupervisor(supervisorRuntime, sessionView, output, false)) {
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
				vscode.window.showInformationMessage(`Logging command session ${session.sessionId}.`);
				await refreshSessions(sessionView, output);
				void followSessionLog(url, session.sessionId, sessionView, output).catch((error: unknown) => vscode.window.showWarningMessage(`Could not follow command session: ${message(error)}`));
			} catch (error) {
				vscode.window.showWarningMessage(`Could not start logged command: ${message(error)}`);
			}
		}),
		vscode.commands.registerCommand('model-worklog.stopSession', async () => {
			if (!await enableSupervisor(supervisorRuntime, sessionView, output, false)) {
				return;
			}
			const url = configuredSupervisorUrl();
			if (url === undefined) {
				return;
			}
			try {
				const sessions = (await listSessions(url)).filter((session) => session.state === 'running' && session.actor === 'codex-app-server');
				const selected = await vscode.window.showQuickPick(sessions.map((session) => ({ label: session.sessionId, description: `Codex session, ${session.eventCount} events`, session })), { title: 'Stop Active Codex Session', placeHolder: 'Select a running Codex session' });
				if (selected === undefined) {
					return;
				}
				await cancelSession(url, selected.session.sessionId);
				vscode.window.showInformationMessage(`Cancellation requested for ${selected.session.sessionId}.`);
				await refreshSessions(sessionView, output);
			} catch (error) {
				vscode.window.showWarningMessage(`Could not stop session: ${message(error)}`);
			}
		}),
		vscode.commands.registerCommand('model-worklog.openSessionLog', async (sessionId: string) => {
			if (!await enableSupervisor(supervisorRuntime, sessionView, output, false)) {
				return;
			}
			const url = configuredSupervisorUrl();
			if (url === undefined) {
				return;
			}
			try {
				await followSessionLog(url, sessionId, sessionView, output);
			} catch (error) {
				vscode.window.showWarningMessage(`Could not read session log: ${message(error)}`);
			}
		}),
		vscode.commands.registerCommand('model-worklog.exportEvidenceBundle', async () => {
			if (!await enableSupervisor(supervisorRuntime, sessionView, output, false)) {
				return;
			}
			const url = configuredSupervisorUrl();
			if (url === undefined) {
				return;
			}
			try {
				const sessions = await listSessions(url);
				const selected = await vscode.window.showQuickPick(sessions.map((session) => ({ label: session.sessionId, description: `${session.state}, ${session.eventCount} events`, session })), { title: 'Export Model Logger Log', placeHolder: 'Select a retained log' });
				if (selected === undefined) {
					return;
				}
				const destination = await vscode.window.showSaveDialog({ title: 'Export Model Logger log', defaultUri: vscode.Uri.file(`model-logger-${selected.session.sessionId}.json`), filters: { 'Model Logger JSON': ['json'] } });
				if (destination === undefined) {
					return;
				}
				const bundle = await getEvidenceBundle(url, selected.session.sessionId);
				await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(`${JSON.stringify(bundle, null, 2)}\n`));
				vscode.window.showInformationMessage(`Exported ${selected.session.sessionId}.`);
			} catch (error) {
				vscode.window.showWarningMessage(`Could not export session: ${message(error)}`);
			}
		}),
	);
}

function requireTrustedWorkspace(): boolean {
	if (vscode.workspace.isTrusted) {
		return true;
	}
	vscode.window.showWarningMessage('Trust this workspace before starting Model Logger processes.');
	return false;
}

async function enableSupervisor(runtime: SupervisorRuntime, sessionView: LoggerSessionsView, output: vscode.OutputChannel, announce: boolean): Promise<boolean> {
	const workspacePath = activeWorkspacePath();
	const url = configuredSupervisorUrl();
	if (workspacePath === undefined || url === undefined) {
		return false;
	}
	try {
		const connection = await runtime.ensureRunning(url);
		const { label, detail } = describeConnection(connection);
		sessionView.setSupervisor(label, detail);
		if (connection.kind !== 'connected') {
			reportConnection(connection);
			return false;
		}
		await trustWorkspace(url, workspacePath);
		await refreshSessions(sessionView, output);
		const location = vscode.env.remoteName === undefined ? 'this computer' : `the ${vscode.env.remoteName} remote environment`;
		output.appendLine(`Model Logger is ready on ${location}.`);
		if (announce) {
			vscode.window.showInformationMessage(`Model Logger is enabled on ${location}.`);
		}
		return true;
	} catch (error) {
		const detail = message(error);
		sessionView.setSupervisor('unavailable', detail);
		vscode.window.showWarningMessage(`Could not enable Model Logger: ${detail}`);
		return false;
	}
}

function configuredSupervisorUrl(): URL | undefined {
	const configuredUrl = vscode.workspace.getConfiguration('model-worklog').get<string>('supervisorUrl');
	if (!configuredUrl) {
		vscode.window.showWarningMessage('No local Model Logger supervisor URL is configured.');
		return undefined;
	}
	try {
		const url = new URL(configuredUrl);
		const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
		if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(host)) {
			vscode.window.showWarningMessage(`Supervisor URL must be loopback HTTP, received ${url.origin}.`);
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
		vscode.window.showWarningMessage(`Invalid supervisor URL: ${configuredUrl}`);
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

function formatTokenUsage(session: SupervisorSession): string {
	return session.tokenUsage.status === 'reported'
		? `${session.tokenUsage.totalTokens} tokens`
		: `tokens ${session.tokenUsage.reason}`;
}

async function refreshSessions(sessionView: LoggerSessionsView, output: vscode.OutputChannel): Promise<void> {
	const url = configuredSupervisorUrl();
	if (url === undefined) {
		return;
	}
	try {
		const sessions = await listSessions(url);
		sessionView.setSessions(sessions);
		output.appendLine(`Loaded ${sessions.length} session${sessions.length === 1 ? '' : 's'}.`);
	} catch (error) {
		sessionView.setSessions([]);
		vscode.window.showWarningMessage(`Could not load sessions: ${message(error)}`);
	}
}

async function followSessionLog(url: URL, sessionId: string, sessionView: LoggerSessionsView, output: vscode.OutputChannel): Promise<void> {
	let afterSequence = 0;
	output.clear();
	output.appendLine(`Model Logger log ${sessionId}`);
	for (;;) {
		const snapshot = await getSessionEventSnapshot(url, sessionId, { afterSequence });
		for (const event of snapshot.events) {
			for (const line of formatSessionEvent(event)) {
				output.appendLine(line);
			}
		}
		output.show(true);
		afterSequence = snapshot.cursor.nextSequence;
		await refreshSessions(sessionView, output);
		if (snapshot.terminal) {
			return;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 250));
	}
}

function reportConnection(connection: SupervisorConnection): void {
	switch (connection.kind) {
		case 'connected':
			return;
		case 'incompatible':
			vscode.window.showWarningMessage(`Model Logger supervisor API ${connection.health.apiVersion} is incompatible with this extension.`);
			return;
		case 'http-error':
		case 'malformed':
			vscode.window.showWarningMessage('The local Model Logger supervisor responded but its health could not be verified.');
			return;
		case 'unreachable':
			vscode.window.showWarningMessage('Model Logger supervisor is unavailable.');
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function deactivate() {}
