import * as vscode from 'vscode';
import { LogQueryRequestSchema, TraceIdSchema, type LogQueryResponse } from 'model-worklog-schema';

import { canAccessTrace, TraceApiError } from './traceApi';
import { TraceController, traceErrorMessage } from './traceController';

interface QueryScope {
	readonly projectId: string;
	readonly traceId?: string;
}

export class TraceQueryCommand implements vscode.Disposable {
	private readonly output = vscode.window.createOutputChannel('Model Logger Answers');
	private readonly registration: vscode.Disposable;
	private readonly shutdown = new AbortController();
	private querying = false;

	constructor(private readonly controller: TraceController) {
		this.registration = vscode.commands.registerCommand('model-worklog.trace.ask', (input: unknown) => this.ask(input));
	}

	dispose(): void { this.shutdown.abort(); this.registration.dispose(); this.output.dispose(); }

	private async ask(input: unknown): Promise<void> {
		if (this.querying) { return; }
		this.querying = true;
		try {
			const scope = await this.selectScope(input);
			if (scope === undefined) { return; }
			const question = await vscode.window.showInputBox({ title: 'Ask Captured Logs', prompt: `Project: ${scope.projectId}`, placeHolder: 'What tools were used? How many times was read_file used?', ignoreFocusOut: true,
				validateInput: (value) => LogQueryRequestSchema.safeParse({ projectId: scope.projectId, question: value }).success ? undefined : 'Enter a question of 1-2000 characters.' });
			if (question === undefined) { return; }
			const answer = await this.retrieve(scope, question);
			if (!this.current(scope)) { return; }
			this.present(answer);
			await this.openEvidence(answer);
		} catch (error) {
			if (error instanceof Error && ['AbortError', 'Canceled'].includes(error.name)) { return; }
			await vscode.window.showWarningMessage(traceErrorMessage(error));
		} finally { this.querying = false; }
	}

	private current(scope: QueryScope): boolean {
		return !this.shutdown.signal.aborted && this.controller.state.enabled && this.controller.state.projectId === scope.projectId;
	}

	private async selectScope(input: unknown): Promise<QueryScope | undefined> {
		const state = this.controller.state;
		if (!state.enabled || !canAccessTrace(state.principal, state.projectId, 'read')) { throw new TraceApiError('forbidden', 'Enable Model Logger with a reader or admin credential for this project.'); }
		const candidate = input !== null && typeof input === 'object' && 'traceId' in input ? input.traceId : state.selectedTraceId;
		const traceId = TraceIdSchema.safeParse(candidate);
		const choices = [{ label: 'All retained traces', description: state.projectId, traceId: undefined as string | undefined }];
		if (traceId.success && state.traces.some((trace) => trace.traceId === traceId.data)) { choices.unshift({ label: 'Selected trace', description: traceId.data, traceId: traceId.data }); }
		const selected = await vscode.window.showQuickPick(choices, { title: 'Ask Captured Logs', placeHolder: 'Query scope', ignoreFocusOut: true });
		return selected === undefined ? undefined : { projectId: state.projectId, traceId: selected.traceId };
	}

	private async retrieve(scope: QueryScope, question: string): Promise<LogQueryResponse> {
		if (!this.current(scope)) { throw new TraceApiError('unavailable', 'The project changed. Ask again in the current project.'); }
		return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Querying captured logs', cancellable: true }, async (_progress, cancellation) => {
			const abort = new AbortController();
			const subscription = cancellation.onCancellationRequested(() => abort.abort());
			try {
				return await this.controller.act('read', (api, projectId, signal) => api.askLogs({ projectId, traceId: scope.traceId, question }, AbortSignal.any([signal, abort.signal, this.shutdown.signal])));
			} finally { subscription.dispose(); }
		});
	}

	private present(answer: LogQueryResponse): void {
		this.output.clear();
		this.output.appendLine(`Project: ${answer.scope.projectId} | Snapshot: ${answer.snapshotAt}`);
		this.output.appendLine(answer.answer);
		for (const source of answer.evidence) { this.output.appendLine(`[${source.id}] ${source.name} | ${source.traceId}/${source.spanId} revision ${source.revision}`); }
		for (const limitation of answer.limitations) { this.output.appendLine(`Note: ${limitation}`); }
		this.output.show(true);
	}

	private async openEvidence(answer: LogQueryResponse): Promise<void> {
		if (answer.evidence.length === 0) { return; }
		const selected = await vscode.window.showQuickPick(answer.evidence.map((source) => ({ label: `[${source.id}] ${source.name}`, description: source.state, detail: `${source.traceId}/${source.spanId} revision ${source.revision}`, source })), { title: 'Cited Evidence', placeHolder: 'Open a cited evidence snapshot, or Escape to keep reading the answer' });
		if (selected === undefined || !this.current(answer.scope)) { return; }
		const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({ snapshotAt: answer.snapshotAt, ...selected.source }, null, 2) });
		await vscode.window.showTextDocument(document, { preview: true });
	}
}
