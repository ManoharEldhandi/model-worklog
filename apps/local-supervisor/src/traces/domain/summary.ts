import type { TraceSummary } from 'model-worklog-schema';

import type { SummarySpan } from './contracts';

function brokenAncestry(spans: readonly SummarySpan[]): boolean {
	const parents = new Map(spans.map((span) => [span.spanId, span.parentSpanId]));
	const checked = new Set<string>();
	for (const span of spans) {
		const path = new Set<string>();
		let current: string | undefined = span.spanId;
		while (current !== undefined && !checked.has(current)) {
			if (!parents.has(current) || path.has(current)) { return true; }
			path.add(current);
			current = parents.get(current);
		}
		for (const identifier of path) { checked.add(identifier); }
	}
	return false;
}

function tokens(span: SummarySpan): { value?: number; complete: boolean } {
	if (span.usage === undefined) { return { complete: false }; }
	const { totalTokens, inputTokens, outputTokens } = span.usage;
	if (totalTokens !== undefined) { return { value: totalTokens, complete: true }; }
	const value = (inputTokens ?? 0) + (outputTokens ?? 0);
	if (!Number.isSafeInteger(value)) { return { complete: false }; }
	return { value, complete: inputTokens !== undefined && outputTokens !== undefined };
}

export function traceCanExpire(spans: readonly SummarySpan[]): boolean {
	return spans.filter((span) => span.parentSpanId === undefined).length === 1
		&& spans.every((span) => span.state !== 'running') && !brokenAncestry(spans);
}

export function summarizeTrace(projectId: string, traceId: string, spans: readonly SummarySpan[], updatedAt: string): TraceSummary {
	const ordered = [...spans].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt) || left.spanId.localeCompare(right.spanId));
	const roots = ordered.filter((span) => span.parentSpanId === undefined);
	const primary = roots[0] ?? ordered[0];
	const earliest = ordered[0];
	if (primary === undefined || earliest === undefined) { throw new Error('Cannot summarize an empty trace.'); }
	let incomplete = roots.length !== 1 || brokenAncestry(spans);
	let state: TraceSummary['state'] = 'completed';
	const usage = new Map<string, number>();
	for (const span of spans) {
		if (span.state === 'running') { state = 'running'; incomplete = true; }
		else if (state !== 'running' && span.state === 'failed') { state = 'failed'; }
		else if (state === 'completed' && span.state === 'interrupted') { state = 'interrupted'; }
		if (span.capture.droppedEvents > 0 || span.capture.truncatedFields > 0) { incomplete = true; }
		if (span.kind !== 'model' || span.state === 'running') { continue; }
		const counts = tokens(span);
		if (!counts.complete) { incomplete = true; }
		if (counts.value === undefined) { continue; }
		const key = span.usageKey ?? `span:${span.spanId}`;
		const previous = usage.get(key);
		if (previous !== undefined && previous !== counts.value) { incomplete = true; }
		usage.set(key, Math.max(previous ?? 0, counts.value));
	}
	const total = [...usage.values()].reduce((sum, value) => sum + value, 0);
	if (!Number.isSafeInteger(total)) { incomplete = true; }
	return {
		projectId, traceId, name: primary.name, serviceName: primary.serviceName, state,
		startedAt: earliest.startedAt, updatedAt, spanCount: spans.length, incomplete,
		...(usage.size > 0 && Number.isSafeInteger(total) ? { totalTokens: total } : {}),
	};
}