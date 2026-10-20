import { createHash } from 'node:crypto';

import { redactAttributes, TraceSpanSchema } from 'model-worklog-schema';

export function projectToolSpans(events, { projectId, parent }) {
	const calls = new Map();
	for (const event of events) {
		if (event.correlationId === undefined || !['tool.called', 'tool.completed'].includes(event.kind)) { continue; }
		const key = `${event.sessionId}/${event.correlationId}`;
		const call = calls.get(key) ?? {};
		if (event.kind === 'tool.called' && call.started === undefined) { call.started = event; }
		if (event.kind === 'tool.completed') { call.completed = event; }
		calls.set(key, call);
	}
	return [...calls.entries()].flatMap(([key, { started, completed }]) => {
		const first = started ?? completed;
		if (first === undefined || typeof first.payload.tool !== 'string') { return []; }
		const clean = redactAttributes({
			'tool.name': first.payload.tool,
			...(typeof first.payload.server === 'string' ? { 'mcp.server.name': first.payload.server } : {}),
			'source.sessionId': first.sessionId,
			'source.eventIds': [started?.eventId, completed?.eventId].filter(Boolean),
			'source.projection': 'copilot-tool-lifecycle',
			...(started?.payload.arguments === undefined ? {} : { input: started.payload.arguments }),
			...(completed?.payload.result === undefined ? {} : { output: completed.payload.result }),
		}, { mode: 'redacted-content' });
		const name = String(clean.attributes['tool.name']).slice(0, 256);
		return [TraceSpanSchema.parse({
			schemaVersion: 1, projectId, traceId: parent.traceId, parentSpanId: parent.spanId,
			spanId: createHash('sha256').update(key).digest('hex').slice(0, 16),
			name, serviceName: 'copilot-tool-projection', kind: 'tool', revision: 1,
			state: completed?.payload.success === true ? 'completed' : completed?.payload.success === false ? 'failed' : 'interrupted',
			startedAt: first.occurredAt,
			endedAt: new Date(Math.max(Date.parse(first.occurredAt), Date.parse(completed?.occurredAt ?? first.occurredAt))).toISOString(),
			attributes: clean.attributes, events: [], links: [],
			capture: { ...clean.report, limitations: ['Projected from correlated captured session events; timing and content are limited to those events.', ...(started === undefined ? ['Tool completion was captured without its start.'] : []), ...(completed === undefined ? ['No tool completion was captured.'] : [])] },
		})];
	});
}
