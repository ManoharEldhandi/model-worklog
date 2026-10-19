import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildSessionActivity, buildTraceActivity, formatActivityText } from './activity';
import { buildSessionLog, buildTraceLog, TraceActivityLogSchema } from './activityLog';
import { formatSessionEventText, presentSessionEvent } from './presentation';
import { EVENT_KINDS, type SessionEvent } from './events';
import { SpanKindSchema, type StoredTraceSpan } from './trace';

function event(kind: SessionEvent['kind'], payload: SessionEvent['payload']): SessionEvent {
	return {
		schemaVersion: 1,
		eventId: 'evt_demo',
		sessionId: 'ses_demo',
		sequence: 4,
		occurredAt: '2026-09-15T12:00:00.000Z',
		kind,
		actor: 'demo-agent',
		evidenceGrade: 'model-declared',
		correlationId: 'tool_42',
		payload,
		redaction: { policyVersion: '1', replacements: 0, truncated: false },
	};
}

test('presents readable reasoning summaries, tools, files, and tool results', () => {
	const reasoning = presentSessionEvent(event('agent.summary', { source: 'reasoning-summary', summary: 'I will inspect the parser before changing it.' }));
	assert.equal(reasoning.title, 'Agent reasoning summary');
	assert.deepEqual(reasoning.details, [{ label: 'Summary', value: 'I will inspect the parser before changing it.' }]);
	assert.equal(presentSessionEvent(event('agent.message', { role: 'user', text: 'Inspect the parser.' })).title, 'User request');

	const lines = formatSessionEventText(event('tool.completed', {
		tool: 'read_file',
		success: true,
		result: { path: 'src/parser.ts', linesRead: 84 },
	}));
	assert.ok(lines.includes('  Tool completed: read_file'));
	assert.ok(lines.includes('  Result: {'));
	assert.ok(lines.includes('      "path": "src/parser.ts",'));
	assert.ok(lines.includes('  Correlation: tool_42'));
});

test('presents file and workspace activity without rendering a raw diff into text', () => {
	const read = presentSessionEvent(event('file.read', { path: 'src/parser.ts', tool: 'read_file' }));
	assert.equal(read.title, 'Read path: src/parser.ts');
	const directory = presentSessionEvent(event('file.read', { path: 'docs', tool: 'Read', pathType: 'directory' }));
	assert.equal(directory.title, 'Inspected directory: docs');

	const change = presentSessionEvent(event('workspace.diff', {
		changedSinceStart: true,
		current: { paths: ['src/parser.ts', 'src/parser.test.ts'], diffSha256: 'abc123', truncated: false },
		diff: 'private diff content is retained in JSON only',
	}));
	assert.equal(change.title, 'Workspace changes detected');
	assert.deepEqual(change.details[0], { label: 'Changed files', value: '[\n  "src/parser.ts",\n  "src/parser.test.ts"\n]' });
	assert.equal(JSON.stringify(change).includes('private diff content'), false);
});

test('uses plain language when a provider did not report token counts', () => {
	const usage = presentSessionEvent({
		...event('usage.unavailable', { message: 'The provider did not send token counters.' }),
		evidenceGrade: 'unknown',
		unknownReason: 'not-observed',
	});
	assert.equal(usage.title, 'Token count not reported');
	assert.deepEqual(usage.details, [{ label: 'Details', value: 'The provider did not send token counters.' }]);
});

test('groups 100 file reads into one activity with every path and source reference', () => {
	const events = Array.from({ length: 100 }, (_, index): SessionEvent => ({
		...event('file.read', { path: `src/file-${index}.ts`, pathType: 'file', tool: 'read_file' }),
		eventId: `evt_${index}`, sequence: index + 1,
		occurredAt: new Date(Date.parse('2026-09-15T12:00:00.000Z') + index * 100).toISOString(),
	}));
	const snapshot = JSON.stringify(events);
	const activities = buildSessionActivity([...events].reverse());
	assert.equal(activities.length, 1);
	const activity = activities[0];
	assert.equal(activity?.title, 'Read 100 files');
	assert.equal(activity?.count, 100);
	assert.equal(activity?.resources.length, 100);
	assert.equal(activity?.sources.length, 100);
	assert.equal(activity?.startedAt, events[0]?.occurredAt);
	assert.equal(activity?.endedAt, events.at(-1)?.occurredAt);
	assert.equal(JSON.stringify(events), snapshot);
});

test('read groups count repeated paths but ignore replayed events and preserve boundaries', () => {
	const first = { ...event('file.read', { path: 'src/parser.ts' }), eventId: 'read_1', sequence: 1 };
	const second = { ...first, eventId: 'read_2', sequence: 2 };
	const response = { ...event('agent.message', { role: 'assistant', text: 'Now checking the tests.' }), eventId: 'message', sequence: 3 };
	const third = { ...first, eventId: 'read_3', sequence: 4 };
	const activities = buildSessionActivity([first, first, second, response, third]);
	assert.equal(activities.length, 3);
	assert.equal(activities[0]?.resources[0]?.count, 2);
	assert.equal(activities[0]?.sources.length, 2);
	assert.equal(activities[1]?.category, 'response');
	assert.equal(activities[2]?.sources[0]?.id, 'read_3');
});

test('activity never merges actors or evidence grades or invents a successful tool result', () => {
	const read = { ...event('file.read', { path: 'src/parser.ts' }), eventId: 'read_1', sequence: 1 };
	const activities = buildSessionActivity([
		read,
		{ ...read, eventId: 'read_2', sequence: 2, actor: 'another-agent' },
		{ ...read, eventId: 'read_3', sequence: 3, evidenceGrade: 'observed-native' },
		{ ...event('tool.completed', { tool: 'lookup' }), eventId: 'tool', sequence: 4 },
	]);
	assert.equal(activities.length, 4);
	assert.equal(activities[3]?.status, 'unknown');
});

test('read tool lifecycles collapse into one segment without losing results or source events', () => {
	const events = Array.from({ length: 100 }, (_, index): SessionEvent[] => {
		const base = { ...event('tool.called', { tool: 'read_file', arguments: { path: `src/${index}.ts` } }), correlationId: `call_${index}` };
		return [
			{ ...base, eventId: `start_${index}`, sequence: index * 3 + 1 },
			{ ...base, eventId: `read_${index}`, sequence: index * 3 + 2, kind: 'file.read', payload: { path: `src/${index}.ts`, tool: 'read_file' } },
			{ ...base, eventId: `end_${index}`, sequence: index * 3 + 3, kind: 'tool.completed', payload: { tool: 'read_file', success: true, result: { linesRead: index } } },
		];
	}).flat();
	const activities = buildSessionActivity(events);
	assert.equal(activities.length, 1);
	assert.equal(activities[0]?.title, 'Read 100 files');
	assert.equal(activities[0]?.status, 'completed');
	assert.equal(activities[0]?.sources.length, 300);
	assert.equal(activities[0]?.details.filter((detail) => detail.label === 'Result').length, 100);
	assert.deepEqual(activities[0]?.tools, [{ name: 'read_file' }]);
});

test('failed reads stay separate and MCP tool identity and interleaved correlations remain visible', () => {
	const events: SessionEvent[] = [
		{ ...event('tool.called', { tool: 'search', server: 'docs-mcp', arguments: { query: 'parser' } }), sequence: 1, eventId: 'mcp_start', correlationId: 'mcp' },
		{ ...event('tool.called', { tool: 'read_file' }), sequence: 2, eventId: 'read_start', correlationId: 'read' },
		{ ...event('file.read', { path: 'missing.ts', tool: 'read_file' }), sequence: 3, eventId: 'read', correlationId: 'read' },
		{ ...event('tool.completed', { tool: 'search', success: true, result: ['parser docs'] }), sequence: 4, eventId: 'mcp_end', correlationId: 'mcp' },
		{ ...event('tool.completed', { tool: 'read_file', success: false, error: 'File not found' }), sequence: 5, eventId: 'read_end', correlationId: 'read' },
		{ ...event('file.read', { path: 'existing.ts' }), sequence: 6, eventId: 'other_read' },
	];
	const activities = buildSessionActivity(events);
	assert.equal(activities.length, 3);
	assert.equal(activities[0]?.title, 'MCP tool: docs-mcp / search');
	assert.equal(activities[0]?.sources.length, 2);
	assert.equal(activities[1]?.status, 'failed');
	assert.match(activities[1]?.title ?? '', /failed/);
	assert.ok(activities[1]?.details.some((detail) => detail.value === 'File not found'));
	assert.equal(activities[2]?.status, 'completed');
});

test('command output chunks join without fabricated newlines and terminal gaps stay explicit', () => {
	const events: SessionEvent[] = [
		{ ...event('command.started', { executable: 'npm', args: ['test'] }), sequence: 1, eventId: 'command' },
		{ ...event('process.output', { stream: 'stdout', text: 'hel' }), sequence: 2, eventId: 'out_1' },
		{ ...event('process.output', { stream: 'stdout', text: 'lo\n' }), sequence: 3, eventId: 'out_2' },
		{ ...event('session.interrupted', {}), sequence: 4, eventId: 'stop' },
	];
	const activities = buildSessionActivity(events);
	assert.equal(activities.length, 3);
	assert.equal(activities[0]?.status, 'unknown');
	assert.ok(activities[0]?.warnings.includes('Completion event was not captured.'));
	assert.equal(activities[1]?.details[0]?.value, 'hello\n');
	assert.equal(activities[1]?.sources.length, 2);
	assert.equal(activities[2]?.status, 'interrupted');
});

test('duplicate correlations are never guessed and long pauses split read segments', () => {
	const start = { ...event('tool.called', { tool: 'search' }), sequence: 1, eventId: 'start_1' };
	const activities = buildSessionActivity([
		start, { ...start, sequence: 2, eventId: 'start_2' },
		{ ...event('tool.completed', { tool: 'search', success: true }), sequence: 3, eventId: 'end' },
		{ ...event('file.read', { path: 'one.ts' }), sequence: 4, eventId: 'one' },
		{ ...event('file.read', { path: 'two.ts' }), sequence: 5, eventId: 'two', occurredAt: '2026-09-15T12:01:00.000Z' },
	]);
	assert.equal(activities.length, 5);
	assert.equal(activities[0]?.status, 'running');
	assert.ok(activities[0]?.warnings.some((warning) => warning.includes('Repeated correlation')));
	assert.ok(activities[2]?.warnings.includes('Start event was not captured.'));
});

function storedSpan(overrides: Partial<StoredTraceSpan['span']> = {}): StoredTraceSpan {
	return {
		evidenceGrade: 'model-declared', receivedAt: '2026-09-15T12:00:02.000Z', sequence: 1,
		span: { schemaVersion: 1, projectId: 'demo', traceId: '1'.repeat(32), spanId: '2'.repeat(16),
			name: 'lookup', serviceName: 'agent', kind: 'tool', startedAt: '2026-09-15T12:00:00.000Z', endedAt: '2026-09-15T12:00:01.000Z',
			state: 'completed', revision: 2, attributes: {}, events: [], links: [],
			capture: { mode: 'metadata', redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: [] }, ...overrides },
	};
}

test('SDK activities keep the final revision, hierarchy, MCP identity and unknown usage', () => {
	const running = storedSpan({ state: 'running', endedAt: undefined, revision: 1 });
	const terminal = storedSpan({ attributes: { 'tool.name': 'search', 'mcp.server.name': 'docs', 'mcp.method': 'tools/call', output: 'Found two matches' } });
	const model = storedSpan({ spanId: '3'.repeat(16), kind: 'model', parentSpanId: terminal.span.spanId, attributes: { 'gen_ai.request.model': 'example-model' } });
	const activities = buildTraceActivity([terminal, running, model]);
	assert.equal(activities.length, 2);
	assert.equal(activities[0]?.title, 'MCP tool: docs / search');
	assert.equal(activities[0]?.sources[0]?.revision, 2);
	assert.equal(activities[0]?.status, 'completed');
	assert.equal(activities[1]?.parentId, activities[0]?.id);
	assert.ok(activities[1]?.details.some((detail) => detail.label === 'Tokens' && detail.value === 'Not reported'));
	assert.ok(activities[0] !== undefined && formatActivityText(activities[0]).join('\n').includes('Found two matches'));
});

test('SDK read groups preserve overlapping time ranges and do not combine different parents', () => {
	const first = storedSpan({ name: 'read', attributes: { 'tool.name': 'read_file', input: { path: 'one.ts' } }, endedAt: '2026-09-15T12:02:00.000Z' });
	const second = storedSpan({ spanId: '3'.repeat(16), name: 'read', attributes: { 'tool.name': 'read_file', input: { path: 'two.ts' } },
		startedAt: '2026-09-15T12:00:01.000Z', endedAt: '2026-09-15T12:00:02.000Z' });
	const otherParent = storedSpan({ spanId: '4'.repeat(16), parentSpanId: '5'.repeat(16), name: 'read',
		attributes: { 'tool.name': 'read_file', input: { path: 'three.ts' } }, startedAt: '2026-09-15T12:00:03.000Z' });
	const activities = buildTraceActivity([first, second, otherParent]);
	assert.equal(activities.length, 2);
	assert.equal(activities[0]?.title, 'Read 2 files');
	assert.equal(activities[0]?.endedAt, first.span.endedAt);
	assert.ok(activities[1]?.warnings.includes('Parent span is not in the loaded capture.'));
});

test('activity projections redact nested secrets and hidden reasoning without changing sources', () => {
	const source = event('tool.completed', { tool: 'lookup', success: true,
		result: { password: 'private-value', reasoning: 'private-reasoning', answer: 'Visible output' } });
	const activity = buildSessionActivity([source]);
	const trace = buildTraceActivity([storedSpan({ attributes: { output: { token: 'private-value', thinking: 'private-reasoning', answer: 'Visible output' } } })]);
	const serialized = JSON.stringify([activity, trace]);
	assert.equal(serialized.includes('private-value'), false);
	assert.equal(serialized.includes('private-reasoning'), false);
	assert.equal(serialized.includes('Visible output'), true);
	assert.equal(source.payload.result !== null && typeof source.payload.result === 'object' && !Array.isArray(source.payload.result) ? source.payload.result.reasoning : undefined, 'private-reasoning');
});

test('every canonical event and SDK span category has an activity representation', () => {
	for (const kind of EVENT_KINDS) {
		const activities = buildSessionActivity([event(kind, {})]);
		assert.equal(activities.length, 1, kind);
		assert.equal(activities[0]?.sources[0]?.kind, kind);
		assert.ok(activities[0]?.title, kind);
	}
	for (const kind of SpanKindSchema.options) {
		const activities = buildTraceActivity([storedSpan({ kind })]);
		assert.equal(activities[0]?.category, kind);
		assert.equal(activities[0]?.sources[0]?.kind, kind);
	}
});

test('failure messages and telemetry loss stay readable instead of being reduced to generic labels', () => {
	const failure = buildSessionActivity([event('session.failed', { state: 'failed', message: 'Provider timed out.' })])[0];
	assert.equal(failure?.status, 'failed');
	assert.ok(failure !== undefined && formatActivityText(failure).join('\n').includes('Provider timed out.'));
	const loss = buildSessionActivity([event('log.truncated', { message: 'Delivery incomplete.', pending: 2, dropped: 3 })])[0];
	assert.ok(loss?.details.some((detail) => detail.label === 'Dropped snapshots' && detail.value === '3'));
});

test('explicit assistant deltas form one message and the final snapshot replaces its text', () => {
	const chunks: SessionEvent[] = Array.from({ length: 100 }, (_, index) => ({
		...event('agent.message', { role: 'assistant', text: `${index} `, delta: true }),
		eventId: `chunk_${index}`, sequence: index + 1, correlationId: 'message_1',
	}));
	const streamed = buildSessionActivity(chunks);
	assert.equal(streamed.length, 1);
	assert.equal(streamed[0]?.details[0]?.value, chunks.map((chunk) => chunk.payload.text).join(''));
	const final = { ...event('agent.summary', { summary: 'Final complete response.', final: true }),
		eventId: 'final', sequence: 101, correlationId: 'message_1' };
	const activities = buildSessionActivity([...chunks, final]);
	assert.equal(activities.length, 1);
	assert.equal(activities[0]?.title, 'Assistant response');
	assert.equal(activities[0]?.details[0]?.value, 'Final complete response.');
	assert.equal(activities[0]?.status, 'completed');
	assert.equal(activities[0]?.sources.length, 101);
	assert.equal(activities[0]?.id, streamed[0]?.id);
});

test('visible plan and reasoning-summary streams join only explicit, correlated fragments', () => {
	for (const source of ['plan', 'reasoning-summary']) {
		const first = { ...event('agent.summary', { summary: 'Check ', source, delta: true }), eventId: 'first', sequence: 1 };
		const second = { ...event('agent.summary', { summary: 'the parser.', source, delta: true }), eventId: 'second', sequence: 2 };
		assert.equal(buildSessionActivity([first, second])[0]?.details[0]?.value, 'Check the parser.');
		assert.equal(buildSessionActivity([first, { ...second, correlationId: undefined }]).length, 2);
		assert.equal(buildSessionActivity([{ ...first, payload: { summary: 'Check ', source } }, second]).length, 2);
	}
});

test('long streamed previews stay bounded while retaining all fragment references', () => {
	const events: SessionEvent[] = Array.from({ length: 20 }, (_, index) => ({
		...event('agent.message', { text: 'visible '.repeat(200), delta: true }), eventId: `chunk_${index}`, sequence: index + 1,
	}));
	const activity = buildSessionActivity(events)[0];
	assert.equal(activity?.sources.length, 20);
	assert.equal(activity?.details[0]?.value.length, 16_000);
	assert.ok(activity?.warnings.some((warning) => warning.startsWith('Stream preview was shortened')));
});

test('read grouping derives arbitrary counts from actual events, not a fixed batch size', () => {
	for (const count of [0, 1, 2, 7, 37, 101, 257]) {
		const events: SessionEvent[] = Array.from({ length: count }, (_, index) => ({
			...event('file.read', { path: `workspace/${index}.txt`, tool: 'application.documents.open' }),
			eventId: `read_${index}`, sequence: index + 1,
		}));
		const activity = buildSessionActivity(events);
		assert.equal(activity.length, count === 0 ? 0 : 1);
		if (count === 0) { continue; }
		assert.equal(activity[0]?.title, `Read ${count} ${count === 1 ? 'file' : 'files'}`);
		assert.equal(activity[0]?.resources.length, count);
		assert.equal(activity[0]?.sources.length, count);
		assert.equal(activity[0]?.tools[0]?.name, 'application.documents.open');
	}
});

test('explicit file semantics support arbitrary SDK tools, MCP servers and action counts', () => {
	for (const count of [1, 3, 19, 113]) {
		const spans = Array.from({ length: count }, (_, index) => storedSpan({ spanId: (index + 1).toString(16).padStart(16, '0'), name: 'document.fetch',
			attributes: { 'tool.name': 'company.docs.fetch', 'mcp.server.name': 'company-documents', 'file.operation': 'read', 'file.path': `docs/${index}.md` } }));
		const activity = buildTraceActivity(spans);
		assert.equal(activity.length, 1);
		assert.equal(activity[0]?.resources.length, count);
		assert.equal(activity[0]?.sources.length, count);
		assert.deepEqual(activity[0]?.tools, [{ name: 'company.docs.fetch', server: 'company-documents' }]);
	}
	const modified = buildTraceActivity([storedSpan({ name: 'persistDocument', attributes: { 'file.operation': 'modified', 'file.path': 'docs/spec.md' } })]);
	assert.equal(modified[0]?.title, 'Modified file: docs/spec.md');
	assert.equal(modified[0]?.resources[0]?.action, 'modified');
	const unrelated = buildTraceActivity([storedSpan({ kind: 'model', attributes: { 'file.operation': 'read', 'file.path': 'docs/spec.md' } })]);
	assert.equal(unrelated[0]?.category, 'model');
	assert.equal(unrelated[0]?.resources.length, 0);
	const unsupported = buildTraceActivity([storedSpan({ name: 'read_file', attributes: { 'file.operation': 'download', 'file.path': 'docs/spec.md' } })]);
	assert.equal(unsupported[0]?.category, 'tool');
});

test('backend logs separate protocol diagnostics and expose one evolving usage summary', () => {
	const inputs: SessionEvent[] = [
		{ ...event('agent.message', { role: 'user', text: 'Review the code.' }), eventId: 'request', sequence: 1 },
		{ ...event('adapter.lifecycle', { adapter: 'any-provider', phase: 'model-call-start' }), eventId: 'start', sequence: 2 },
		{ ...event('file.read', { path: 'one.ts' }), eventId: 'read_one', sequence: 3 },
		{ ...event('adapter.lifecycle', { adapter: 'any-provider', phase: 'model-call-finished' }), eventId: 'finish', sequence: 4 },
		{ ...event('file.read', { path: 'two.ts' }), eventId: 'read_two', sequence: 5 },
		{ ...event('usage.reported', { inputTokens: 10, outputTokens: 5, totalTokens: 15, providerResponseId: 'first' }), eventId: 'usage_one', sequence: 6 },
		{ ...event('usage.reported', { inputTokens: 20, outputTokens: 6, totalTokens: 26, providerResponseId: 'second' }), eventId: 'usage_two', sequence: 7 },
		{ ...event('session.completed', {}), eventId: 'complete', sequence: 8 },
	];
	const log = buildSessionLog(inputs);
	assert.deepEqual(log.entries.map((entry) => entry.category), ['request', 'files', 'usage']);
	assert.equal(log.entries[1]?.title, 'Read 2 files');
	assert.equal(log.usage.counts.totalTokens, 41);
	assert.equal(log.usage.requests, 2);
	assert.equal(log.diagnostics.length, 3);
	assert.equal(log.state, 'completed');
	assert.equal(log.sourceCount, 8);
	assert.equal(log.entries.at(-1)?.sources.length, 2);
	assert.equal(buildSessionLog(inputs.slice(0, 6)).entries.at(-1)?.id, log.entries.at(-1)?.id);
});

test('backend logs preserve read / reasoning / read order and report capability gaps once', () => {
	const inputs: SessionEvent[] = [
		{ ...event('file.read', { path: 'one.ts' }), eventId: 'first', sequence: 1 },
		{ ...event('agent.summary', { source: 'reasoning-summary', summary: 'The parser delegates validation; inspect that next.' }), eventId: 'reasoning', sequence: 2 },
		{ ...event('file.read', { path: 'validation.ts' }), eventId: 'second', sequence: 3 },
		{ ...event('agent.summary', { message: 'Private reasoning unavailable.' }), eventId: 'gap_one', sequence: 4, evidenceGrade: 'unknown', unknownReason: 'redacted' },
		{ ...event('agent.summary', { message: 'Private reasoning unavailable.' }), eventId: 'gap_two', sequence: 5, evidenceGrade: 'unknown', unknownReason: 'redacted' },
	];
	const log = buildSessionLog(inputs);
	assert.deepEqual(log.entries.map((entry) => entry.category), ['files', 'reasoning-summary', 'files']);
	assert.equal(log.capture.reasoning, 'provided');
	assert.equal(log.diagnostics.length, 2);
	assert.equal(log.entries.some((entry) => entry.title.includes('unavailable')), false);
});

test('backend usage deduplicates request identities and never replaces missing counters with zero', () => {
	const first = { ...event('usage.reported', { provider: 'provider', providerResponseId: 'request', inputTokens: 5 }), eventId: 'first', sequence: 1 };
	const replay = { ...first, eventId: 'retry', sequence: 2 };
	const log = buildSessionLog([first, replay]);
	assert.equal(log.usage.requests, 1);
	assert.equal(log.usage.counts.inputTokens, 5);
	assert.equal(log.usage.counts.outputTokens, undefined);
	assert.equal(log.usage.status, 'partial');
	assert.equal(log.entries.length, 1);
	assert.throws(() => buildSessionLog([first, { ...first, sessionId: 'another' , eventId: 'other' }]), /one session/);
});

test('semantic log entries expose ready-to-use operation results and distinguish directories from files', () => {
	const log = buildSessionLog([
		{ ...event('tool.called', { tool: 'view', arguments: { path: 'src/parser.ts' } }), sequence: 1, eventId: 'start' },
		{ ...event('file.read', { tool: 'view', path: 'src/parser.ts', pathType: 'file' }), sequence: 2, eventId: 'read' },
		{ ...event('tool.completed', { tool: 'view', success: true, result: { content: 'export const parser = true;' } }), sequence: 3, eventId: 'result' },
		{ ...event('file.read', { tool: 'view', path: 'src', pathType: 'directory' }), sequence: 4, eventId: 'directory', correlationId: 'other' },
	]);
	assert.equal(log.entries.length, 1);
	assert.equal(log.entries[0]?.details.length, 0);
	assert.equal(JSON.stringify(log.entries[0]?.operations[0]?.result), JSON.stringify({ content: 'export const parser = true;' }));
	assert.deepEqual(log.entries[0]?.operations[0]?.sourceIds, ['start', 'read', 'result']);
	assert.equal(log.summary.filesRead, 1);
	assert.equal(log.summary.directoriesInspected, 1);
});

test('semantic log completion cannot leave an abandoned tool looking active', () => {
	const log = buildSessionLog([
		{ ...event('tool.called', { tool: 'lookup' }), sequence: 1, eventId: 'start' },
		{ ...event('session.completed', {}), sequence: 2, eventId: 'complete' },
	]);
	assert.equal(log.entries[0]?.status, 'unknown');
	assert.equal(log.entries[0]?.operations[0]?.status, 'unknown');
});

test('interleaved reasoning streams retain their first position and replace deltas with the final text', () => {
	const log = buildSessionLog([
		{ ...event('agent.summary', { source: 'reasoning-summary', summary: 'Inspect ', delta: true }), eventId: 'reason_1', sequence: 1, correlationId: 'reason' },
		{ ...event('file.read', { path: 'parser.ts' }), eventId: 'read', sequence: 2 },
		{ ...event('agent.summary', { source: 'reasoning-summary', summary: 'the parser.', delta: true }), eventId: 'reason_2', sequence: 3, correlationId: 'reason' },
		{ ...event('agent.summary', { source: 'reasoning-summary', summary: 'Inspect the parser.', final: true }), eventId: 'reason_final', sequence: 4, correlationId: 'reason' },
	]);
	assert.equal(log.entries.length, 2);
	assert.equal(log.entries[0]?.details[0]?.value, 'Inspect the parser.');
	assert.equal(log.entries[0]?.sources.length, 3);
	assert.equal(log.entries[1]?.resources[0]?.path, 'parser.ts');
});

test('SDK trace logs aggregate model usage once, preserve operations and declare partial pages', () => {
	const root = storedSpan({ kind: 'agent', usage: { source: 'adapter-reported', totalTokens: 999 } });
	const first = storedSpan({ kind: 'model', spanId: '3'.repeat(16), usage: { source: 'provider-reported', requestId: 'request', totalTokens: 10, inputTokens: 6, outputTokens: 4 } });
	const replay = storedSpan({ ...first.span, spanId: '4'.repeat(16) });
	const log = buildTraceLog([root, first, replay], { projectId: root.span.projectId, traceId: root.span.traceId, nextCursor: 'more' });
	assert.equal(log.usage.counts.totalTokens, 10);
	assert.equal(log.usage.requests, 1);
	assert.equal(log.usage.status, 'partial');
	assert.equal(log.entries.filter((entry) => entry.category === 'usage').length, 1);
	assert.equal(log.nextCursor, 'more');
	assert.equal(TraceActivityLogSchema.safeParse(log).success, true);
	assert.throws(() => buildTraceLog([root], { projectId: 'other', traceId: root.span.traceId }), /outside/);
});

test('semantic usage marks conflicts and overflow partial without inventing a usable total', () => {
	const first = { ...event('usage.reported', { providerResponseId: 'request', totalTokens: 10 }), eventId: 'first', sequence: 1 };
	const conflict = { ...first, payload: { providerResponseId: 'request', totalTokens: 12 }, eventId: 'second', sequence: 2 };
	assert.equal(buildSessionLog([first, conflict]).usage.status, 'partial');
	const overflow = buildSessionLog([
		{ ...first, payload: { totalTokens: Number.MAX_SAFE_INTEGER } },
		{ ...conflict, payload: { totalTokens: 1 } },
	]);
	assert.equal(overflow.usage.counts.totalTokens, undefined);
	assert.equal(overflow.usage.status, 'partial');
});

test('sub-agents with matching correlation IDs cannot inherit each other\'s results or streams', () => {
	const events: SessionEvent[] = [
		{ ...event('tool.called', { tool: 'lookup', agentId: 'one' }), eventId: 'start_one', sequence: 1 },
		{ ...event('tool.called', { tool: 'lookup', agentId: 'two' }), eventId: 'start_two', sequence: 2 },
		{ ...event('tool.completed', { tool: 'lookup', agentId: 'two', success: false, error: 'worker two failed' }), eventId: 'end_two', sequence: 3 },
		{ ...event('tool.completed', { tool: 'lookup', agentId: 'one', success: true, result: 'worker one result' }), eventId: 'end_one', sequence: 4 },
	];
	const log = buildSessionLog(events);
	assert.equal(log.entries.length, 2);
	assert.equal(log.entries[0]?.agentId, 'one');
	assert.equal(log.entries[0]?.operations[0]?.result, 'worker one result');
	assert.equal(log.entries[1]?.agentId, 'two');
	assert.equal(log.entries[1]?.operations[0]?.error, 'worker two failed');
});

test('trace reasoning requires an explicit exposed event, not arbitrary reasoning fields', () => {
	const stored = storedSpan({ events: [
		{ name: 'agent.reasoning.summary', at: '2026-09-15T12:00:00.500Z', attributes: { visibility: 'provider-exposed', summary: 'Inspect the validation result next.' } },
		{ name: 'private.reasoning', at: '2026-09-15T12:00:00.600Z', attributes: { reasoning: 'private text' } },
	] });
	const log = buildTraceLog([stored], { projectId: stored.span.projectId, traceId: stored.span.traceId });
	assert.equal(log.entries.filter((entry) => entry.category === 'reasoning-summary').length, 1);
	assert.equal(log.capture.reasoning, 'provided');
	assert.equal(JSON.stringify(log).includes('private text'), false);
});

test('whitespace stream chunks preserve exact content without creating empty active rows', () => {
	const inputs: SessionEvent[] = [
		{ ...event('agent.message', { text: 'Hello', delta: true }), eventId: 'word_one', sequence: 1, correlationId: 'message' },
		{ ...event('agent.message', { text: '\n', delta: true }), eventId: 'newline', sequence: 2, correlationId: 'message' },
		{ ...event('agent.message', { text: 'world', delta: true }), eventId: 'word_two', sequence: 3, correlationId: 'message' },
		{ ...event('agent.message', { text: 'Hello\nworld', final: true }), eventId: 'final', sequence: 4, correlationId: 'message' },
		{ ...event('agent.message', { text: '\n', delta: true }), eventId: 'late_padding', sequence: 5, correlationId: 'message' },
		{ ...event('agent.summary', { source: 'reasoning-summary', summary: '\n\n', delta: true }), eventId: 'padding_only', sequence: 6, correlationId: 'empty_reasoning' },
	];
	const log = buildSessionLog(inputs, { state: 'completed' });
	assert.equal(log.entries.length, 1);
	assert.equal(log.entries[0]?.details[0]?.value, 'Hello\nworld');
	assert.equal(log.entries[0]?.status, 'completed');
	assert.equal(log.entries[0]?.sources.length, 5);
	assert.equal(log.capture.reasoning, 'not-reported');
	assert.equal(log.diagnostics.length, 1);
});

test('empty tool-call messages do not split a read segment and incomplete real streams become unknown', () => {
	const log = buildSessionLog([
		{ ...event('file.read', { path: 'one.ts' }), eventId: 'read_one', sequence: 1 },
		{ ...event('agent.message', { role: 'assistant', text: '', final: true }), eventId: 'tool_envelope', sequence: 2, correlationId: 'empty' },
		{ ...event('file.read', { path: 'two.ts' }), eventId: 'read_two', sequence: 3 },
		{ ...event('agent.message', { role: 'assistant', text: 'Partial response', delta: true }), eventId: 'partial', sequence: 4, correlationId: 'unfinished' },
	], { state: 'completed' });
	assert.equal(log.entries[0]?.title, 'Read 2 files');
	assert.equal(log.entries[1]?.status, 'unknown');
	assert.ok(log.entries[1]?.warnings.includes('Final stream snapshot was not captured.'));
});

test('semantic MCP operation identity remains attached to its own arguments and result', () => {
	const log = buildSessionLog([
		{ ...event('tool.called', { tool: 'vendor_docs_lookup', originalTool: 'lookup', server: 'docs', method: 'tools/call', arguments: { query: 'inventory' } }), sequence: 1, eventId: 'start' },
		{ ...event('tool.completed', { tool: 'vendor_docs_lookup', success: true, result: { content: 'Inventory reference found.' } }), sequence: 2, eventId: 'end' },
	]);
	assert.equal(log.entries[0]?.operations[0]?.name, 'lookup');
	assert.equal(log.entries[0]?.operations[0]?.server, 'docs');
	assert.equal(log.entries[0]?.operations[0]?.method, 'tools/call');
	assert.equal(log.entries[0]?.details.find((detail) => detail.label === 'Result')?.value, 'Inventory reference found.');
});

test('provider errors remain explicit failed notices instead of hidden protocol chatter', () => {
	const log = buildSessionLog([event('adapter.lifecycle', { adapter: 'provider', phase: 'failed', userFacing: true, message: 'Rate limit exceeded.' })]);
	assert.equal(log.entries[0]?.category, 'notice');
	assert.equal(log.entries[0]?.status, 'failed');
	assert.equal(log.summary.failedActions, 1);
	assert.equal(log.diagnostics.length, 0);
	assert.ok(log.lines.some((line) => line.includes('Rate limit exceeded.')));
});