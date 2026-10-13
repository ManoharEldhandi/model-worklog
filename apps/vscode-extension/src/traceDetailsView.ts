import * as vscode from 'vscode';
import type { TraceState } from './traceController';
import { traceDetailsHtml } from './traceDetailsHtml';
import { presentTraceDetail, type TraceDetailModel } from './tracePresentation';

export class TraceDetailsView implements vscode.WebviewViewProvider, vscode.Disposable {
	private view: vscode.WebviewView | undefined;
	private model: TraceDetailModel;
	private ready = false;
	private disposables: vscode.Disposable[] = [];

	constructor(state: TraceState, private readonly visibility: (visible: boolean) => void, private readonly loadMore: () => void) {
		this.model = presentTraceDetail(state);
	}

	resolveWebviewView(view: vscode.WebviewView): void {
		this.disposeView();
		this.view = view;
		this.ready = false;
		view.webview.options = { enableScripts: true, localResourceRoots: [] };
		this.disposables.push(
			view.onDidChangeVisibility(() => this.visibility(view.visible)),
			view.onDidDispose(() => { this.disposeView(); this.visibility(false); }),
			view.webview.onDidReceiveMessage((message: unknown) => {
				if (typeof message !== 'object' || message === null || !('type' in message)) { return; }
				if (message.type === 'ready') { this.ready = true; this.post(); }
				if (message.type === 'more' && 'key' in message && message.key === this.model.key && this.model.more && !this.model.busy) { this.loadMore(); }
			}),
		);
		view.webview.html = traceDetailsHtml();
		this.visibility(view.visible);
	}

	update(state: TraceState): void { this.model = presentTraceDetail(state); this.post(); }
	async show(): Promise<void> {
		await vscode.commands.executeCommand('workbench.view.extension.model-worklog-details');
		this.view?.show(true);
		await vscode.commands.executeCommand('model-worklog.traceDetails.focus');
	}
	dispose(): void { this.disposeView(); this.visibility(false); }
	private disposeView(): void {
		this.view = undefined;
		this.ready = false;
		for (const disposable of this.disposables.splice(0)) { disposable.dispose(); }
	}
	private post(): void {
		if (this.ready && this.view !== undefined) { void this.view.webview.postMessage({ type: 'render', model: this.model }); }
	}
}