import type { StoredTraceSpan, TraceSummary } from 'model-worklog-schema';
import { TraceApiError, type TraceApi } from './traceApi';

export interface TracePage<Item> { readonly items: readonly Item[]; readonly nextCursor: string | null }
export interface CollectedTracePage<Item> extends TracePage<Item> { readonly pages: number }
export const TRACE_VIEW_PAGE_LIMIT = 10;
export const TRACE_EXPORT_PAGE_LIMIT = 100;

export async function collectTracePages<Item>(
	read: (cursor?: string) => Promise<TracePage<Item>>,
	pageLimit: number, itemLimit: number, allowPartial: boolean, signal: AbortSignal,
): Promise<CollectedTracePage<Item>> {
	const items: Item[] = [];
	const cursors = new Set<string>();
	let cursor: string | undefined;
	let bytes = 0;
	for (let pages = 1; pages <= pageLimit; pages += 1) {
		signal.throwIfAborted();
		const page = await read(cursor);
		signal.throwIfAborted();
		bytes += Buffer.byteLength(JSON.stringify(page.items));
		if (items.length + page.items.length > itemLimit || bytes > 16 * 1_024 * 1_024) {
			throw new TraceApiError('bounds', 'Trace data exceeds the item or 16 MiB safety limit. No partial export was saved.');
		}
		items.push(...page.items);
		if (page.nextCursor !== null) {
			if (page.nextCursor.length === 0 || page.nextCursor.length > 4_096 || cursors.has(page.nextCursor)) {
				throw new TraceApiError('bounds', 'Trace pagination repeated or returned an invalid cursor. Refresh and retry.');
			}
			cursors.add(page.nextCursor);
		}
		if (page.nextCursor === null || (allowPartial && pages === pageLimit)) { return { items, nextCursor: page.nextCursor, pages }; }
		cursor = page.nextCursor;
	}
	throw new TraceApiError('bounds', 'Trace pagination exceeds the page safety limit. No partial export was saved.');
}

export function readTraceList(api: TraceApi, projectId: string, pages: number, signal: AbortSignal): Promise<CollectedTracePage<TraceSummary>> {
	return collectTracePages(async (cursor) => {
		const page = await api.list(projectId, cursor, signal);
		return { items: page.traces, nextCursor: page.nextCursor };
	}, pages, 1_000, true, signal);
}

export function readTraceSpans(api: TraceApi, projectId: string, traceId: string, pages: number, signal: AbortSignal, allowPartial = true): Promise<CollectedTracePage<StoredTraceSpan>> {
	return collectTracePages(async (cursor) => {
		const page = await api.detail(projectId, traceId, cursor, signal);
		return { items: page.spans, nextCursor: page.nextCursor };
	}, pages, allowPartial ? 1_000 : 10_000, allowPartial, signal);
}