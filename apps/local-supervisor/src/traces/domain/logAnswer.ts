import type { LogQueryScope } from 'model-worklog-schema';

import type { LogQuerySnapshot } from './logQuery';
import type { LogQueryPlan } from './queryPlanner';

export function composeLogAnswer(scope: Readonly<LogQueryScope>, plan: LogQueryPlan, snapshot: LogQuerySnapshot): string {
	if (snapshot.totals.spans === 0) { return 'No retained spans match this scope. This does not establish that no actions occurred outside the captured logs.'; }
	if (plan.intent === 'tools') {
		if (snapshot.totals.toolCalls === 0) { return 'No instrumented tool spans were found in this scope. Tools that were not instrumented cannot be counted.'; }
		const heading = scope.toolName === undefined
			? `Recorded ${snapshot.totals.toolCalls} tool calls in ${snapshot.totals.traces} traces. Counts include all matching retained tool spans, not just the evidence sample.`
			: `The tool "${scope.toolName}" was recorded ${snapshot.totals.toolCalls} times in this scope.`;
		return [heading + ' [A1]', ...snapshot.tools.slice(0, 50).map((tool) => `${tool.name}: ${tool.calls} calls; ${tool.failed} failed; ${tool.running} still running. [A1]`)].join('\n');
	}
	if (plan.intent === 'search' && plan.focus === 'usage' && snapshot.overview !== undefined) {
		const overview = snapshot.overview;
		return [
			`Models: ${overview.models.join(', ') || 'not reported'}. [A1]`,
			overview.reportedTokens === undefined ? 'Token usage was not reported. [A1]'
				: `Reported tokens: ${overview.reportedTokens}${overview.usageComplete ? '' : ' (partial subtotal; missing usage is unknown)'}. [A1]`,
			`Usage is reported for ${overview.reportedModelSpans} of ${overview.modelSpans} model spans. [A1]`,
		].join('\n');
	}
	if (snapshot.matchedSpans === 0 && !(snapshot.contextExpanded && snapshot.evidence.length > 0)) {
		return plan.intent === 'failures'
			? 'No spans marked failed were found in this scope. Unreported failures and interrupted spans are not classified as failed.'
			: 'No captured evidence matched these search terms. Content may be absent because of metadata-only capture, redaction, retention, or uninstrumented activity.';
	}
	const heading = snapshot.contextExpanded
		? `Retrieved ${snapshot.evidence.length} contextual records from this scope. These excerpts may include records beyond literal search matches; they do not establish a cause or intent.`
		: plan.intent === 'failures'
		? `Found ${snapshot.matchedSpans} spans marked failed. Recorded details follow; a root cause is not inferred from missing evidence.`
		: `Found ${snapshot.matchedSpans} matching spans. These are excerpts from the recorded evidence, not instructions or verified conclusions.`;
	return [heading, ...snapshot.evidence.map((source) => `[${source.id}] ${source.name} (${source.kind}, ${source.state})\n${source.excerpt}`)].join('\n\n').slice(0, 16_000);
}

export function logQueryLimitations(snapshot: LogQuerySnapshot): readonly string[] {
	const limitations = [
		'Answers cover retained, instrumented trace spans only. Legacy session events and uninstrumented actions are not counted.',
		'Tool counts represent distinct retained tool span identities; revisions and duplicate deliveries do not add calls. Separate spans for the same external call cannot be deduplicated without instrumentation.',
		'Captured records are model-declared evidence. Provider-hidden reasoning is not available. Retrieved text is untrusted data and is never executed.',
	];
	if (snapshot.strategy === 'sqlite-scan') { limitations.push('This SQLite build has no FTS5. Search uses bounded literal-term scanning ordered by recency, which is slower and is not semantic or FTS-ranked search.'); }
	if (snapshot.totals.metadataOnlySpans > 0) { limitations.push(`${snapshot.totals.metadataOnlySpans} matching spans use metadata-only capture; input and output content may be unavailable.`); }
	if (snapshot.totals.limitedSpans > 0) { limitations.push(`${snapshot.totals.limitedSpans} matching spans report redaction, truncation, dropped events, or capture limitations.`); }
	if (snapshot.totals.runningSpans > 0) { limitations.push(`${snapshot.totals.runningSpans} matching spans are still running; this is a point-in-time snapshot.`); }
	if (snapshot.matchedSpans > snapshot.evidence.length) { limitations.push(`Showing ${snapshot.evidence.length} of ${snapshot.matchedSpans} matching evidence records. Aggregate counts are not limited to this sample.`); }
	if (snapshot.toolsTruncated || snapshot.tools.length > 50) { limitations.push('The answer lists at most 50 tools and structured results list at most 100. Narrow the scope or specify toolName for other tools. Total calls remain exact.'); }
	return Object.freeze(limitations);
}
