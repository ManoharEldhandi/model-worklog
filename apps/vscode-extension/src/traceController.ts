import { ProjectIdSchema, TraceIdSchema, type StoredTraceSpan, type TracePrincipal, type TraceSummary } from 'model-worklog-schema';
import { canAccessTrace, TraceApiError, type TraceAccess, type TraceApi } from './traceApi';
import { readTraceList, readTraceSpans, TRACE_VIEW_PAGE_LIMIT } from './tracePages';
import { TraceRequests } from './traceRequests';

export type TracePhase = 'disabled' | 'loading' | 'ready' | 'error' | 'unauthorized';
export interface TraceState {
	readonly enabled: boolean;
	readonly projectId: string;
	readonly phase: TracePhase;
	readonly notice: string;
	readonly principal: TracePrincipal | undefined;
	readonly traces: readonly TraceSummary[];
	readonly nextCursor: string | null;
	readonly selectedTraceId: string | undefined;
	readonly spans: readonly StoredTraceSpan[];
	readonly detailPhase: TracePhase;
	readonly detailNotice: string;
	readonly detailCursor: string | null;
	readonly busy: boolean;
}
export type TraceSchedule = (callback: () => void, milliseconds: number) => () => void;

export function traceErrorMessage(error: unknown): string {
	return error instanceof TraceApiError ? error.message : error instanceof Error && error.name === 'TimeoutError'
		? 'Trace request timed out. Refresh to retry.' : 'Trace operation failed. Reconnect or retry.';
}

export class TraceController {
	private readonly requests = new TraceRequests();
	private readonly listeners = new Set<(state: TraceState) => void>();
	private api: TraceApi | undefined;
	private visible = false;
	private disposed = false;
	private cancelPoll: (() => void) | undefined;
	private listPages = 1;
	private detailPages = 1;
	private current: TraceState;

	constructor(projectId = 'default', private readonly schedule: TraceSchedule = (callback, milliseconds) => {
		const timer = setTimeout(callback, milliseconds);
		return () => clearTimeout(timer);
	}) {
		this.current = { enabled: false, projectId, phase: 'disabled', notice: 'Enable Model Logger to connect.', principal: undefined,
			traces: [], nextCursor: null, selectedTraceId: undefined, spans: [], detailPhase: 'disabled', detailNotice: '', detailCursor: null, busy: false };
	}

	get state(): TraceState { return this.current; }
	subscribe(listener: (state: TraceState) => void): { dispose(): void } {
		this.listeners.add(listener);
		listener(this.current);
		return { dispose: () => { this.listeners.delete(listener); } };
	}

	beginConnection(): number {
		this.reset();
		this.patch({ enabled: true, phase: 'loading', principal: undefined, notice: 'Connecting to the trace service...' });
		return this.requests.revision;
	}

	connectionFailed(attempt: number): void {
		if (attempt === this.requests.revision) { this.patch({ phase: 'error', notice: 'The supervisor could not connect. Reconnect Model Logger to retry.' }); }
	}

	async enable(api: TraceApi, attempt?: number): Promise<void> {
		if (this.disposed || (attempt !== undefined && attempt !== this.requests.revision)) { return; }
		if (attempt === undefined) { this.reset(); }
		this.api = api;
		this.patch({ enabled: true, phase: 'loading', principal: undefined, notice: 'Checking trace identity...' });
		await this.refresh();
	}

	disable(): void {
		this.reset();
		this.api = undefined;
		this.patch({ enabled: false, phase: 'disabled', principal: undefined, notice: 'Model Logger is disabled.', traces: [], nextCursor: null,
			selectedTraceId: undefined, spans: [], detailPhase: 'disabled', detailNotice: '', detailCursor: null });
	}

	async setProject(projectId: string): Promise<void> {
		if (this.disposed || projectId === this.current.projectId) { return; }
		this.reset();
		this.listPages = 1;
		this.detailPages = 1;
		this.patch({ projectId, principal: undefined, traces: [], nextCursor: null, selectedTraceId: undefined, spans: [], detailCursor: null, detailNotice: '', detailPhase: 'disabled' });
		await this.refresh();
	}

	setVisible(visible: boolean): void {
		if (this.disposed || this.visible === visible) { return; }
		this.visible = visible;
		this.cancelPoll?.();
		if (visible && this.current.enabled) { void this.refresh(); }
	}

	async refresh(): Promise<void> {
		if (!this.current.enabled || this.disposed) { return; }
		if (!ProjectIdSchema.safeParse(this.current.projectId).success) {
			this.patch({ phase: 'error', notice: 'Invalid project ID. Select a project using letters, digits, dots, underscores or hyphens (1-64 characters).' });
			return;
		}
		await this.load('refresh', async (api, projectId, signal) => {
			const principal = await api.identity(signal);
			if (!canAccessTrace(principal, projectId, 'read')) {
				return { principal, phase: 'unauthorized', notice: 'A reader or admin credential for this project is required.', traces: [], spans: [], detailPhase: 'unauthorized' };
			}
			const page = await readTraceList(api, projectId, this.listPages, signal);
			this.listPages = page.pages;
			const detail = this.current.selectedTraceId === undefined ? {} : await this.readDetail(api, projectId, this.current.selectedTraceId, signal);
			return { principal, phase: 'ready', notice: '', traces: [...new Map(page.items.map((trace) => [trace.traceId, trace])).values()], nextCursor: page.nextCursor, ...detail };
		});
	}

	async loadMore(): Promise<void> {
		if (this.current.busy || this.current.nextCursor === null) { return; }
		if (this.listPages >= TRACE_VIEW_PAGE_LIMIT) { this.patch({ notice: 'Showing the maximum 10 pages. Select another project or refresh.' }); return; }
		this.listPages += 1;
		await this.refresh();
	}

	async select(traceId: string): Promise<void> {
		if (!this.current.enabled || !TraceIdSchema.safeParse(traceId).success || !this.current.traces.some((trace) => trace.traceId === traceId)) { return; }
		if (traceId !== this.current.selectedTraceId) {
			this.reset();
			this.detailPages = 1;
			this.patch({ selectedTraceId: traceId, spans: [], detailCursor: null, detailPhase: 'loading', detailNotice: 'Loading spans...' });
		}
		await this.load('detail', (api, projectId, signal) => this.readDetail(api, projectId, traceId, signal), true);
	}

	async loadMoreSpans(): Promise<void> {
		if (this.current.busy || this.current.detailCursor === null || this.current.selectedTraceId === undefined) { return; }
		if (this.detailPages >= TRACE_VIEW_PAGE_LIMIT) { this.patch({ detailNotice: 'Showing the maximum 10 pages. Export JSON to collect more stored spans.' }); return; }
		this.detailPages += 1;
		await this.select(this.current.selectedTraceId);
	}

	clearSelection(): void {
		this.reset();
		this.patch({ selectedTraceId: undefined, spans: [], detailPhase: 'disabled', detailNotice: '', detailCursor: null });
		this.poll();
	}

	async act<Value>(access: TraceAccess, action: (api: TraceApi, projectId: string, signal: AbortSignal) => Promise<Value>): Promise<Value> {
		const api = this.api;
		const projectId = this.current.projectId;
		if (api === undefined || !this.current.enabled || !canAccessTrace(this.current.principal, projectId, access)) {
			throw new TraceApiError('forbidden', 'The current trace identity does not permit this action.');
		}
		const task = this.requests.run(Symbol(access), async (signal) => {
			if (!canAccessTrace(await api.identity(signal), projectId, access)) { throw new TraceApiError('forbidden', 'Trace permissions have changed. Refresh and retry.'); }
			return action(api, projectId, signal);
		});
		this.patch({ busy: true });
		try { return await task; }
		finally { this.patch({ busy: this.requests.busy }); this.poll(); }
	}

	async idle(): Promise<void> { await this.requests.idle(); }
	dispose(): void { this.disable(); this.disposed = true; this.listeners.clear(); }

	private async readDetail(api: TraceApi, projectId: string, traceId: string, signal: AbortSignal): Promise<Partial<TraceState>> {
		try {
			const page = await readTraceSpans(api, projectId, traceId, this.detailPages, signal);
			this.detailPages = page.pages;
			const byId = new Map<string, StoredTraceSpan>();
			for (const stored of page.items) {
				if ((byId.get(stored.span.spanId)?.span.revision ?? 0) <= stored.span.revision) { byId.set(stored.span.spanId, stored); }
			}
			return { spans: [...byId.values()], detailCursor: page.nextCursor, detailPhase: 'ready', detailNotice: '' };
		} catch (error) {
			signal.throwIfAborted();
			const denied = error instanceof TraceApiError && ['unauthorized', 'forbidden'].includes(error.kind);
			return { detailPhase: denied ? 'unauthorized' : 'error', detailNotice: traceErrorMessage(error), ...(denied ? { principal: undefined } : {}) };
		}
	}

	private async load(key: string, read: (api: TraceApi, projectId: string, signal: AbortSignal) => Promise<Partial<TraceState>>, detail = false): Promise<void> {
		const api = this.api;
		if (api === undefined || this.disposed) { return; }
		const revision = this.requests.revision;
		const projectId = this.current.projectId;
		const task = this.requests.run(key, (signal) => read(api, projectId, signal));
		this.patch({ busy: true });
		try {
			const patch = await task;
			if (revision === this.requests.revision) { this.patch(patch); }
		} catch (error) {
			if (revision === this.requests.revision) {
				const phase = error instanceof TraceApiError && ['unauthorized', 'forbidden'].includes(error.kind) ? 'unauthorized' : 'error';
				this.patch(detail ? { detailPhase: phase, detailNotice: traceErrorMessage(error) } : { phase, notice: traceErrorMessage(error), principal: undefined });
			}
		} finally { this.patch({ busy: this.requests.busy }); this.poll(); }
	}

	private reset(): void { this.cancelPoll?.(); this.requests.reset(); }
	private patch(patch: Partial<TraceState>): void {
		if (this.disposed) { return; }
		this.current = { ...this.current, ...patch };
		for (const listener of this.listeners) { listener(this.current); }
	}
	private poll(): void {
		this.cancelPoll?.();
		if (this.current.enabled && this.visible && !this.disposed && !this.requests.busy) {
			this.cancelPoll = this.schedule(() => { void this.refresh(); }, 5_000);
		}
	}
}