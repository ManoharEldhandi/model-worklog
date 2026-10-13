import * as vscode from 'vscode';
import { canAccessTrace } from './traceApi';
import { TraceController, type TraceState } from './traceController';
import { presentTrace } from './tracePresentation';
import { INTEGRATION_SCOPE, TRACE_CAPTURE_SCOPE } from './tracePrivacy';

export interface TraceSelection { readonly projectId: string; readonly traceId: string }
export type TraceTreeItem = { readonly kind: 'project' | 'status' | 'setup' | 'more' | 'empty' }
	| ({ readonly kind: 'trace' } & TraceSelection);

export class TraceSidebar implements vscode.TreeDataProvider<TraceTreeItem>, vscode.Disposable {
	private readonly changes = new vscode.EventEmitter<TraceTreeItem | undefined>();
	private readonly subscription: { dispose(): void };
	private state: TraceState;
	readonly onDidChangeTreeData = this.changes.event;

	constructor(controller: TraceController) {
		this.state = controller.state;
		this.subscription = controller.subscribe((state) => { this.state = state; this.changes.fire(undefined); });
	}

	getChildren(parent?: TraceTreeItem): TraceTreeItem[] {
		if (parent !== undefined) { return []; }
		const state = this.state;
		const rows: TraceTreeItem[] = [{ kind: 'project' }];
		if (state.phase !== 'ready' || state.notice || state.busy) { rows.push({ kind: 'status' }); }
		if (state.enabled && canAccessTrace(state.principal, state.projectId, 'admin')) { rows.push({ kind: 'setup' }); }
		if (state.enabled && canAccessTrace(state.principal, state.projectId, 'read')) {
			rows.push(...state.traces.map((trace): TraceTreeItem => ({ kind: 'trace', projectId: trace.projectId, traceId: trace.traceId })));
			if (state.phase === 'ready' && state.traces.length === 0) { rows.push({ kind: 'empty' }); }
			if (state.nextCursor !== null) { rows.push({ kind: 'more' }); }
		}
		return rows;
	}

	getTreeItem(element: TraceTreeItem): vscode.TreeItem {
		const state = this.state;
		const item = new vscode.TreeItem('');
		item.id = `trace/${state.projectId}/${element.kind === 'trace' ? element.traceId : element.kind}`;
		switch (element.kind) {
			case 'project':
				item.label = `Project: ${state.projectId}`;
				item.iconPath = new vscode.ThemeIcon('folder');
				item.tooltip = `${TRACE_CAPTURE_SCOPE}\n${INTEGRATION_SCOPE}`;
				item.command = { command: 'model-worklog.trace.selectProject', title: 'Select Trace Project' };
				break;
			case 'trace': {
				const summary = state.traces.find((trace) => trace.traceId === element.traceId);
				if (summary === undefined) { item.label = 'Trace no longer available'; break; }
				const presentation = presentTrace(summary);
				item.label = presentation.title;
				item.description = presentation.description;
				item.tooltip = `${presentation.description}\n${presentation.tooltip}`;
				item.iconPath = new vscode.ThemeIcon(presentation.icon);
				item.contextValue = canAccessTrace(state.principal, state.projectId, 'admin') ? 'trace-admin' : 'trace-reader';
				item.command = { command: 'model-worklog.trace.open', title: 'Open Trace', arguments: [{ projectId: element.projectId, traceId: element.traceId }] };
				break;
			}
			case 'status':
				item.label = state.phase === 'disabled' ? 'Enable Model Logger' : state.phase === 'unauthorized' ? 'Trace access denied'
					: state.phase === 'error' ? 'Trace service unavailable' : state.busy ? 'Loading traces...' : state.notice;
				item.tooltip = state.notice || TRACE_CAPTURE_SCOPE;
				item.iconPath = new vscode.ThemeIcon(state.phase === 'disabled' ? 'play' : state.phase === 'unauthorized' ? 'lock' : state.phase === 'error' ? 'error' : state.busy ? 'sync~spin' : 'info');
				if (!state.busy) { item.command = { command: state.enabled ? 'model-worklog.trace.refresh' : 'model-worklog.enable', title: state.enabled ? 'Refresh Traces' : 'Enable Model Logger' }; }
				break;
			case 'setup':
				item.label = 'Configure SDK Logging';
				item.iconPath = new vscode.ThemeIcon('settings-gear');
				item.tooltip = 'Create a private, single-project SDK writer credential. No arbitrary chat observation is enabled.';
				if (!state.busy) { item.command = { command: 'model-worklog.trace.configureSdk', title: 'Configure SDK Logging' }; }
				break;
			case 'more':
				item.label = 'Load More Traces';
				item.iconPath = new vscode.ThemeIcon('chevron-down');
				if (!state.busy) { item.command = { command: 'model-worklog.trace.loadMore', title: 'Load More Traces' }; }
				break;
			case 'empty':
				item.label = `No traces in ${state.projectId}`;
				item.iconPath = new vscode.ThemeIcon('inbox');
				item.tooltip = 'Instrument your application with model-worklog-sdk and use this project ID. Enabling the view alone does not generate traces.';
				break;
		}
		return item;
	}

	dispose(): void { this.subscription.dispose(); this.changes.dispose(); }
}