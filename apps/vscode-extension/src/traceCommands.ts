import * as vscode from 'vscode';
import { ProjectIdSchema, TraceIdSchema } from 'model-worklog-schema';
import { TraceApiError } from './traceApi';
import { TraceController, traceErrorMessage } from './traceController';
import { TraceDetailsView } from './traceDetailsView';
import { exportTrace } from './traceExport';
import type { TraceSelection } from './traceSidebar';
import { configureTraceWriter, sdkQuickstart, WriterSetupError } from './traceWriterSetup';

export function traceProject(): string {
	return vscode.workspace.getConfiguration('model-worklog').get<string>('trace.projectId', 'default');
}

export class TraceCommands implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[];
	private readonly output = vscode.window.createOutputChannel('Model Logger SDK');
	private configuring = false;

	constructor(private readonly controller: TraceController, private readonly details: TraceDetailsView) {
		const command = (name: string, action: (input: unknown) => Promise<unknown>): vscode.Disposable =>
			vscode.commands.registerCommand(`model-worklog.trace.${name}`, (input: unknown) => this.run(() => action(input)));
		this.disposables = [this.output,
			command('refresh', () => controller.refresh()), command('loadMore', () => controller.loadMore()),
			command('loadMoreSpans', () => controller.loadMoreSpans()), command('selectProject', () => this.selectProject()),
			command('open', async (input) => { const selected = this.selection(input); if (selected !== undefined) { await controller.select(selected.traceId); await details.show(); } }),
			command('export', (input) => this.exportSelected(input)), command('delete', (input) => this.deleteSelected(input)),
			command('configureSdk', () => this.configure()),
		];
	}

	dispose(): void { for (const disposable of this.disposables) { disposable.dispose(); } }

	private async run(action: () => Promise<unknown>): Promise<void> {
		try { await action(); }
		catch (error) {
			if (error instanceof Error && error.name === 'AbortError') { return; }
			if (error instanceof WriterSetupError && error.credentialToRevoke !== undefined) { await this.retryRevocation(error.credentialToRevoke, error.message); return; }
			await vscode.window.showWarningMessage(error instanceof WriterSetupError ? error.message : traceErrorMessage(error));
		}
	}

	private selection(input: unknown): TraceSelection | undefined {
		const state = this.controller.state;
		const candidate = input === undefined ? { projectId: state.projectId, traceId: state.selectedTraceId } : input;
		if (typeof candidate !== 'object' || candidate === null || !('projectId' in candidate) || !('traceId' in candidate)
			|| !ProjectIdSchema.safeParse(candidate.projectId).success || !TraceIdSchema.safeParse(candidate.traceId).success) { return undefined; }
		const selection = { projectId: String(candidate.projectId), traceId: String(candidate.traceId) };
		if (selection.projectId !== state.projectId || !state.enabled || !state.traces.some((trace) => trace.traceId === selection.traceId)) {
			throw new TraceApiError('unavailable', 'The trace selection changed. Select the trace again.');
		}
		return selection;
	}

	private requireSelection(expected: TraceSelection): void {
		if (!this.controller.state.enabled || this.controller.state.projectId !== expected.projectId || this.controller.state.selectedTraceId !== expected.traceId) {
			throw new TraceApiError('unavailable', 'The trace selection changed. Select the trace again.');
		}
	}

	private async exportSelected(input: unknown): Promise<void> {
		const selected = this.selection(input);
		if (selected === undefined) { return; }
		await this.controller.select(selected.traceId);
		const destination = await vscode.window.showSaveDialog({ title: 'Export Captured Trace JSON',
			defaultUri: vscode.Uri.file(`trace-${selected.projectId}-${selected.traceId}.json`), filters: { JSON: ['json'] } });
		if (destination === undefined) { return; }
		this.requireSelection(selected);
		await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Exporting captured trace pages', cancellable: true }, async (_progress, cancellation) => {
			const abort = new AbortController();
			const subscription = cancellation.onCancellationRequested(() => abort.abort());
			try {
				await this.controller.act('read', async (api, projectId, signal) => {
					this.requireSelection(selected);
					const combined = AbortSignal.any([signal, abort.signal]);
					const summary = this.controller.state.traces.find((trace) => trace.traceId === selected.traceId);
					const exported = await exportTrace(api, projectId, selected.traceId, combined, summary);
					combined.throwIfAborted();
					this.requireSelection(selected);
					await vscode.workspace.fs.writeFile(destination, new TextEncoder().encode(`${JSON.stringify(exported, null, 2)}\n`));
				});
			} finally { subscription.dispose(); }
		});
		await vscode.window.showInformationMessage('Exported all returned pages of retained trace data. Underlying execution may be incomplete.');
	}

	private async deleteSelected(input: unknown): Promise<void> {
		const selected = this.selection(input);
		if (selected === undefined) { return; }
		await this.controller.select(selected.traceId);
		const answer = await vscode.window.showWarningMessage(`Delete trace ${selected.traceId}?`, { modal: true,
			detail: `Project: ${selected.projectId}\nPermanently removes the stored trace. An active application can submit more spans afterward.` }, 'Delete Trace');
		if (answer !== 'Delete Trace') { return; }
		this.requireSelection(selected);
		await this.controller.act('admin', async (api, projectId, signal) => { this.requireSelection(selected); await api.deleteTrace(projectId, selected.traceId, signal); });
		this.requireSelection(selected);
		this.controller.clearSelection();
		await this.controller.refresh();
		await vscode.window.showInformationMessage(`Deleted trace ${selected.traceId} from ${selected.projectId}.`);
	}

	private async projectInput(title: string): Promise<string | undefined> {
		return vscode.window.showInputBox({ title, prompt: 'Project ID', value: this.controller.state.projectId, ignoreFocusOut: true,
			validateInput: (value) => ProjectIdSchema.safeParse(value).success ? undefined : 'Use 1-64 letters, digits, dots, underscores or hyphens; start with a letter or digit.' });
	}
	private async selectProject(): Promise<void> {
		const projectId = await this.projectInput('Select Trace Project');
		if (projectId !== undefined) { await this.saveProject(projectId); }
	}
	private async saveProject(projectId: string): Promise<void> {
		ProjectIdSchema.parse(projectId);
		if (vscode.workspace.workspaceFolders === undefined) { await this.controller.setProject(projectId); return; }
		await vscode.workspace.getConfiguration('model-worklog').update('trace.projectId', projectId, vscode.ConfigurationTarget.Workspace);
		await this.controller.setProject(projectId);
	}

	private async configure(): Promise<void> {
		if (this.configuring) { return; }
		if (!vscode.workspace.isTrusted) { throw new WriterSetupError('Trust the workspace before creating an SDK credential.'); }
		this.configuring = true;
		try {
			const projectId = await this.projectInput('Configure SDK Logging');
			if (projectId === undefined) { return; }
			const result = await this.controller.act('admin', (api, _currentProject, signal) => configureTraceWriter(api, projectId, {
				signal, confirmReplace: async (existing) => await vscode.window.showWarningMessage('Replace the existing SDK writer credential?', {
					modal: true, detail: `Project: ${existing.projectId}\nStatus: ${existing.status}\nExpires: ${existing.expiresAt ?? 'unknown'}\nApplications using the previous credential must restart after replacement.`,
				}, 'Replace Writer Credential') === 'Replace Writer Credential',
			}));
			if (result === undefined) { return; }
			this.output.clear();
			this.output.appendLine(sdkQuickstart(projectId));
			this.output.appendLine(`Writer credential expires: ${result.expiresAt}`);
			this.output.appendLine('The SDK reads trace-writer-token in MODEL_WORKLOG_HOME (default: ~/.model-worklog). Keep the application and supervisor in the same environment.');
			this.output.appendLine('Metadata capture is the supervisor default. No content capture or agent hooks were enabled by this command.');
			this.output.show(true);
			await this.saveProject(projectId);
			if (result.previousRevocationFailed !== undefined) { await this.retryRevocation(result.previousRevocationFailed, 'The new writer is ready, but the previous credential could not be revoked.'); }
			await vscode.window.showInformationMessage(`SDK logging configured for ${projectId}. Writer credential saved privately; expires ${result.expiresAt}.`);
		} finally { this.configuring = false; }
	}

	private async retryRevocation(id: string, message: string): Promise<void> {
		const answer = await vscode.window.showWarningMessage(message, { modal: true, detail: `Credential ID to revoke: ${id}. This is an identifier, not a token.` }, 'Retry Revocation');
		if (answer !== 'Retry Revocation') { return; }
		try { await this.controller.act('admin', (api, _projectId, signal) => api.revokeCredential(id, signal)); }
		catch { await vscode.window.showErrorMessage(`Credential ${id} still requires administrator revocation. No credential token was displayed.`); }
	}
}