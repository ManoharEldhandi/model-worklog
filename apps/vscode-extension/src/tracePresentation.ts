import type { SpanUsage, StoredTraceSpan, TraceSummary } from 'model-worklog-schema';
import { canAccessTrace } from './traceApi';
import type { TraceState } from './traceController';
import { publicStoredSpan, traceText, TRACE_CAPTURE_SCOPE } from './tracePrivacy';

export interface SpanNode {
	readonly id: string;
	readonly stored: StoredTraceSpan;
	parentId: string | undefined;
	warning: string | undefined;
}
export interface SpanForest {
	readonly nodes: readonly SpanNode[];
	readonly missingParents: readonly string[];
	readonly cycles: readonly string[];
}
export interface TraceField { readonly label: string; readonly value: string }
export interface PresentedSpan {
	readonly id: string;
	readonly parentId: string | undefined;
	readonly name: string;
	readonly summary: string;
	readonly warning: string | undefined;
	readonly fields: readonly TraceField[];
}

export interface TraceDetailModel {
	readonly key: string;
	readonly title: string;
	readonly meta: string;
	readonly notice: string;
	readonly warnings: readonly string[];
	readonly spans: readonly PresentedSpan[];
	readonly more: boolean;
	readonly busy: boolean;
}

export function presentTraceDetail(state: TraceState): TraceDetailModel {
	const summary = state.traces.find((trace) => trace.traceId === state.selectedTraceId);
	const readable = canAccessTrace(state.principal, state.projectId, 'read') && state.detailPhase !== 'unauthorized';
	const forest = buildSpanForest(readable ? state.spans : []);
	let notice = state.detailNotice || state.notice;
	if (!state.enabled) { notice = 'Model Logger is disabled.'; }
	else if (state.selectedTraceId === undefined) { notice = 'No trace selected.'; }
	else if (state.detailPhase === 'ready' && forest.nodes.length === 0) { notice = 'No stored spans in this trace.'; }
	return {
		key: `${state.projectId}/${state.selectedTraceId ?? ''}`,
		title: summary === undefined ? 'Trace Details' : traceText(summary.name || summary.traceId),
		meta: `${state.projectId}${state.selectedTraceId === undefined ? '' : ` / ${state.selectedTraceId}`} | ${state.detailPhase}${state.busy ? ' | refreshing' : ''}`,
		notice, warnings: state.selectedTraceId === undefined || !readable ? [] : traceWarnings(forest, summary, state.detailCursor !== null),
		spans: forest.nodes.map(presentSpan), more: readable && state.detailCursor !== null, busy: state.busy,
	};
}

export function traceTokenCount(value: number | undefined): string {
	return value === undefined ? 'not reported' : value.toLocaleString('en-US');
}

export function presentTrace(trace: TraceSummary): { title: string; description: string; tooltip: string; icon: string } {
	return { title: traceText(trace.name || trace.traceId),
		description: `${trace.state} | ${traceText(trace.serviceName)} | ${trace.spanCount} spans | tokens: ${traceTokenCount(trace.totalTokens)}${trace.incomplete ? ' | incomplete' : ''}`,
		tooltip: `${trace.projectId} / ${trace.traceId}\n${TRACE_CAPTURE_SCOPE}\nReported token totals cover only spans that supplied usage.${trace.incomplete ? '\nIncomplete capture reported by the supervisor.' : ''}`,
		icon: trace.incomplete ? 'warning' : trace.state === 'running' ? 'sync~spin' : trace.state === 'failed' ? 'error' : trace.state === 'interrupted' ? 'debug-pause' : 'check',
	};
}

export function buildSpanForest(spans: readonly StoredTraceSpan[]): SpanForest {
	const latest = new Map<string, StoredTraceSpan>();
	for (const stored of spans) {
		if ((latest.get(stored.span.spanId)?.span.revision ?? 0) <= stored.span.revision) { latest.set(stored.span.spanId, stored); }
	}
	const nodes = [...latest.values()].sort((left, right) => left.span.startedAt.localeCompare(right.span.startedAt) || left.span.spanId.localeCompare(right.span.spanId))
		.map((stored): SpanNode => ({ id: stored.span.spanId, stored, parentId: stored.span.parentSpanId, warning: undefined }));
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const missing = new Set<string>();
	const cycles = new Set<string>();
	for (const node of nodes) {
		if (node.parentId !== undefined && !byId.has(node.parentId)) {
			missing.add(node.parentId);
			node.warning = `Parent ${node.parentId} is not in the loaded capture; shown at the top level.`;
			node.parentId = undefined;
		}
	}
	const visited = new Set<string>();
	for (const node of nodes) {
		const chain = new Map<string, SpanNode>();
		let ancestor: SpanNode | undefined = node;
		while (ancestor !== undefined && !visited.has(ancestor.id)) {
			if (chain.has(ancestor.id)) {
				let inCycle = false;
				for (const candidate of chain.values()) {
					if (candidate.id === ancestor.id) { inCycle = true; }
					if (inCycle) { candidate.parentId = undefined; candidate.warning = 'Cyclic parent links; shown at the top level.'; cycles.add(candidate.id); }
				}
				break;
			}
			chain.set(ancestor.id, ancestor);
			ancestor = ancestor.parentId === undefined ? undefined : byId.get(ancestor.parentId);
		}
		for (const id of chain.keys()) { visited.add(id); }
	}
	return { nodes, missingParents: [...missing].sort(), cycles: [...cycles].sort() };
}

export function traceWarnings(forest: SpanForest, summary?: TraceSummary, morePages = false): string[] {
	const warnings = [TRACE_CAPTURE_SCOPE, 'Provider-hidden reasoning is not collected.'];
	if (morePages) { warnings.push('More stored spans are available. Missing parents may be on later pages.'); }
	if (summary?.incomplete) { warnings.push('The supervisor reports this trace as incomplete.'); }
	if (summary !== undefined && summary.spanCount !== forest.nodes.length) { warnings.push(`Span count gap: summary reports ${summary.spanCount}; ${forest.nodes.length} unique spans loaded.`); }
	if (forest.missingParents.length > 0) { warnings.push(`${forest.missingParents.length} parent span(s) are missing from this capture.`); }
	if (forest.cycles.length > 0) { warnings.push(`${forest.cycles.length} span(s) have cyclic parent links.`); }
	if (forest.nodes.some(({ stored }) => stored.span.state === 'running')) { warnings.push('Running spans may have later revisions.'); }
	for (const counter of ['redactedFields', 'truncatedFields', 'droppedEvents'] as const) {
		const total = forest.nodes.reduce((sum, node) => sum + node.stored.span.capture[counter], 0);
		if (total > 0) { warnings.push(`${counter}: ${total}`); }
	}
	for (const limitation of new Set(forest.nodes.flatMap(({ stored }) => stored.span.capture.limitations))) { warnings.push(traceText(limitation)); }
	return warnings;
}

export function usageFields(usage?: SpanUsage): TraceField[] {
	return [
		{ label: 'Usage source', value: usage?.source ?? 'unknown (not reported)' },
		{ label: 'Provider', value: usage?.provider ?? 'unknown (not reported)' },
		{ label: 'Model', value: usage?.model ?? 'unknown (not reported)' },
		{ label: 'Request ID', value: usage?.requestId ?? 'unknown (not reported)' },
		...(['totalTokens', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'] as const)
			.map((key) => ({ label: key, value: usage?.[key] === undefined ? 'unknown (not reported)' : traceTokenCount(usage[key]) })),
	];
}

export function presentSpan(node: SpanNode): PresentedSpan {
	const { span, receivedAt, sequence, evidenceGrade } = publicStoredSpan(node.stored);
	const duration = span.endedAt === undefined ? 'running (end not reported)' : `${Date.parse(span.endedAt) - Date.parse(span.startedAt)} ms`;
	return { id: node.id, parentId: node.parentId, name: span.name, warning: node.warning,
		summary: `${span.state} | ${span.kind} | ${duration} | tokens: ${traceTokenCount(span.usage?.totalTokens)}`,
		fields: [
			{ label: 'Span ID', value: span.spanId }, { label: 'Parent span ID', value: span.parentSpanId ?? 'root' },
			{ label: 'Service', value: span.serviceName }, { label: 'Status / category', value: `${span.state} / ${span.kind}` },
			{ label: 'Started', value: span.startedAt }, { label: 'Ended', value: span.endedAt ?? 'not reported' },
			{ label: 'Revision', value: String(span.revision) }, { label: 'Received / sequence', value: `${receivedAt} / ${sequence}` },
			{ label: 'Evidence grade', value: evidenceGrade },
			{ label: 'Capture', value: `${span.capture.mode} | redacted: ${span.capture.redactedFields} | truncated: ${span.capture.truncatedFields} | dropped events: ${span.capture.droppedEvents}` },
			{ label: 'Limitations', value: span.capture.limitations.join('\n') || 'None reported; capture completeness is unknown.' },
			{ label: 'Error', value: JSON.stringify(span.attributes['error.type']) ?? 'not reported' },
			{ label: 'Attributes', value: Object.keys(span.attributes).length === 0 ? 'No captured attributes.' : JSON.stringify(span.attributes, null, 2) },
			{ label: 'Events', value: span.events.length === 0 ? 'No captured events; uncaptured events are unknown.' : JSON.stringify(span.events, null, 2) },
			{ label: 'Links', value: span.links.length === 0 ? 'No reported links.' : JSON.stringify(span.links, null, 2) },
			...usageFields(span.usage),
		],
	};
}