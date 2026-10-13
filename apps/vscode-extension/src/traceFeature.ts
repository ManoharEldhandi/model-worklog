import * as vscode from 'vscode';
import { TraceApi, canAccessTrace } from './traceApi';
import { TraceCommands, traceProject } from './traceCommands';
import { TraceController } from './traceController';
import { TraceDetailsView } from './traceDetailsView';
import { TraceSidebar, type TraceTreeItem } from './traceSidebar';

export class TraceFeature implements vscode.Disposable {
	readonly controller = new TraceController(traceProject());
	private readonly disposables: vscode.Disposable[];
	private readonly tree: vscode.TreeView<TraceTreeItem>;
	private detailsVisible = false;

	constructor() {
		const sidebar = new TraceSidebar(this.controller);
		this.tree = vscode.window.createTreeView('model-worklog.traces', { treeDataProvider: sidebar });
		const details = new TraceDetailsView(this.controller.state, (visible) => {
			this.detailsVisible = visible;
			this.controller.setVisible(this.tree.visible || visible);
		}, () => { void this.controller.loadMoreSpans(); });
		this.disposables = [sidebar, this.tree, details, new TraceCommands(this.controller, details),
			vscode.window.registerWebviewViewProvider('model-worklog.traceDetails', details, { webviewOptions: { retainContextWhenHidden: true } }),
			this.tree.onDidChangeVisibility(() => this.controller.setVisible(this.tree.visible || this.detailsVisible)),
			this.controller.subscribe((state) => {
				details.update(state);
				this.tree.description = state.projectId;
				const contexts = {
					'modelWorklog.traceEnabled': state.enabled,
					'modelWorklog.traceRead': state.enabled && canAccessTrace(state.principal, state.projectId, 'read'),
					'modelWorklog.traceAdmin': state.enabled && canAccessTrace(state.principal, state.projectId, 'admin'),
					'modelWorklog.traceSelected': state.selectedTraceId !== undefined,
					'modelWorklog.traceBusy': state.busy,
				};
				for (const [key, value] of Object.entries(contexts)) { void vscode.commands.executeCommand('setContext', key, value); }
			}),
			vscode.workspace.onDidChangeConfiguration((event) => {
				if (event.affectsConfiguration('model-worklog.trace.projectId')) { void this.controller.setProject(traceProject()); }
				if (event.affectsConfiguration('model-worklog.supervisorUrl')) { this.disable(); }
			}),
		];
		this.controller.setVisible(this.tree.visible);
	}

	beginConnection(): number { return this.controller.beginConnection(); }
	connectionFailed(attempt: number): void { this.controller.connectionFailed(attempt); }
	async connect(url: URL, attempt: number): Promise<void> {
		try { await this.controller.enable(new TraceApi(url), attempt); }
		catch { await vscode.window.showWarningMessage('SDK traces could not connect. Existing session logging is unchanged.'); return; }
		if (this.controller.state.phase === 'error' || this.controller.state.phase === 'unauthorized') {
			await vscode.window.showWarningMessage(`SDK traces: ${this.controller.state.notice} Existing session logging is unchanged.`);
		}
	}
	disable(): void { this.controller.disable(); }
	dispose(): void { this.controller.dispose(); for (const disposable of this.disposables) { disposable.dispose(); } }
}