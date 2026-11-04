import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';

import type { TraceSpan } from 'model-worklog-schema';

import type { PreparedSpan } from '../domain/contracts';
import { planLogQuery } from '../domain/queryPlanner';
import { traceSpan } from '../fixtures.test';
import { TraceDatabase } from './database';
import { TraceFileGuard } from './files';
import { SqliteLogQueryRepository } from './logQueryRepository';
import { LocalLogQueryAdmission } from './logQueryAdmission';
import { SqliteLogSearchIndex } from './logSearchIndex';
import { SqliteTraceRepository } from './repository';

const limits = { maxStoredSpans: 1000, maxStoredBytes: 8 * 1024 * 1024, maxSpansPerTrace: 1000 };

function prepared(overrides: Partial<TraceSpan> = {}): PreparedSpan {
	const span = traceSpan({ kind: 'tool', name: 'read_file', ...overrides });
	return { span, contentHash: createHash('sha256').update(JSON.stringify(span)).digest('hex'), identityHash: span.name };
}

async function store(context: TestContext) {
	const directory = await mkdtemp(join(tmpdir(), 'log-query-'));
	const database = new TraceDatabase(new TraceFileGuard(directory), limits);
	context.after(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
	const index = new SqliteLogSearchIndex(database);
	index.initialize();
	return { database, index, repository: new SqliteTraceRepository(database, limits, [index]), queries: new SqliteLogQueryRepository(database) };
}

test('exact usage counts cover all retained spans, not top-k samples or revisions', async (context) => {
	const { repository, queries } = await store(context);
	const spans = Array.from({ length: 120 }, (_, index) => prepared({ spanId: (index + 1).toString(16).padStart(16, '0') }));
	repository.ingest(spans, spans[0]!.span.startedAt);
	repository.ingest([spans[0]!, prepared({ spanId: spans[0]!.span.spanId, revision: 2, attributes: { output: 'updated inventory' } }), prepared({ projectId: 'other' })], spans[0]!.span.startedAt);
	const result = queries.retrieve({ projectId: 'project' }, planLogQuery('What tools were used?'), 3);
	assert.equal(result.totals.toolCalls, 120);
	assert.equal(result.tools[0]?.calls, 120);
	assert.equal(result.evidence.length, 3);
	assert.equal(result.matchedSpans, 120);
	assert.equal(result.evidence.every((source) => source.projectId === 'project'), true);
});

test('FTS updates atomically, rejects search syntax as instructions, and drops deleted evidence', async (context) => {
	const { repository, queries } = await store(context);
	const first = prepared({ attributes: { output: 'olduniqueword inventory' } });
	repository.ingest([first], first.span.startedAt);
	assert.equal(queries.retrieve({ projectId: 'project' }, planLogQuery('olduniqueword'), 8).matchedSpans, 1);
	repository.ingest([prepared({ revision: 2, attributes: { output: 'newuniqueword inventory' } })], first.span.startedAt);
	assert.equal(queries.retrieve({ projectId: 'project' }, planLogQuery('olduniqueword'), 8).matchedSpans, 0);
	assert.equal(queries.retrieve({ projectId: 'project' }, planLogQuery('newuniqueword'), 8).evidence[0]?.revision, 2);
	assert.throws(() => repository.ingest([prepared({ spanId: '2'.repeat(16), attributes: { output: 'rollbackword' } }), prepared({ revision: 2 })], first.span.startedAt), /different content/);
	assert.equal(queries.retrieve({ projectId: 'project' }, planLogQuery('rollbackword'), 8).matchedSpans, 0);
	assert.doesNotThrow(() => queries.retrieve({ projectId: 'project' }, planLogQuery('" OR * NOT () -- inventory'), 8));
	assert.equal(repository.delete('project', first.span.traceId), true);
	assert.equal(queries.retrieve({ projectId: 'project' }, planLogQuery('newuniqueword'), 8).matchedSpans, 0);
});

test('query filters isolate project, trace, tool, time, and failed states', async (context) => {
	const { repository, queries } = await store(context);
	const first = prepared({ attributes: { 'tool.name': 'lookup', output: 'inventory missing' }, state: 'failed' });
	repository.ingest([first, prepared({ traceId: '2'.repeat(32), startedAt: '2026-10-14T00:00:00.000Z', endedAt: '2026-10-14T00:00:01.000Z' }), prepared({ projectId: 'other' })], first.span.startedAt);
	const result = queries.retrieve({ projectId: 'project', traceId: first.span.traceId, toolName: 'LOOKUP', since: first.span.startedAt, until: first.span.startedAt }, planLogQuery('Which tools failed?'), 8);
	assert.equal(result.totals.spans, 1);
	assert.equal(result.tools[0]?.name, 'lookup');
	assert.equal(result.evidence[0]?.state, 'failed');
	assert.equal(queries.retrieve({ projectId: 'project', toolName: 'absent' }, planLogQuery('tools'), 8).totals.spans, 0);
	assert.equal(queries.retrieve({ projectId: 'project', since: '2026-10-15T00:00:00.000Z' }, planLogQuery('inventory'), 8).matchedSpans, 0);
	assert.equal(queries.retrieve({ projectId: 'other' }, planLogQuery('inventory'), 8).matchedSpans, 0);
	repository.ingest([prepared({ traceId: '3'.repeat(32), startedAt: '2026-10-16T00:00:00Z', endedAt: '2026-10-16T00:00:01Z' })], first.span.startedAt);
	assert.equal(queries.retrieve({ projectId: 'project', since: '2026-10-16T00:00:00.000Z', until: '2026-10-16T00:00:00.000Z' }, planLogQuery('tools'), 8).totals.toolCalls, 1);
});

test('large tool inventories disclose truncation without changing exact totals or named-tool filters', async (context) => {
	const { repository, queries } = await store(context);
	const spans = Array.from({ length: 105 }, (_, index) => prepared({ spanId: (index + 1).toString(16).padStart(16, '0'), name: `tool-${String(index).padStart(3, '0')}` }));
	repository.ingest(spans, spans[0]!.span.startedAt);
	const result = queries.retrieve({ projectId: 'project' }, planLogQuery('tools'), 20);
	assert.equal(result.totals.toolCalls, 105);
	assert.equal(result.tools.length, 100);
	assert.equal(result.toolsTruncated, true);
	assert.equal(result.evidence.length, 20);
	assert.equal(queries.retrieve({ projectId: 'project', toolName: 'tool-104' }, planLogQuery('tools'), 8).totals.toolCalls, 1);
});

test('index initialization backfills existing spans once and retention removes index entries', async (context) => {
	const { database, index, repository, queries } = await store(context);
	if (index.available) { database.transaction(true, () => { database.statement('DROP TABLE span_search').run(); }); }
	const unindexed = new SqliteTraceRepository(database, limits);
	const first = prepared({ attributes: { output: 'historicalevidence' } });
	unindexed.ingest([first], first.span.startedAt);
	index.initialize();
	index.initialize();
	assert.equal(queries.retrieve({ projectId: 'project' }, planLogQuery('historicalevidence'), 8).matchedSpans, 1);
	assert.equal(repository.cleanup('project', '2027-01-01T00:00:00.000Z', 100).deleted, 1);
	assert.equal(queries.retrieve({ projectId: 'project' }, planLogQuery('historicalevidence'), 8).matchedSpans, 0);
});

test('a dirty index is rebuilt transactionally before indexed reads resume', async (context) => {
	const { database, index, repository, queries } = await store(context);
	if (!index.available) { context.skip('This runtime uses the portable SQLite search strategy.'); return; }
	const first = prepared({ attributes: { output: 'beforeupgrade' } });
	repository.ingest([first], first.span.startedAt);
	const unindexed = new SqliteTraceRepository(database, limits);
	unindexed.ingest([prepared({ revision: 2, attributes: { output: 'afterupgrade' } })], first.span.startedAt);
	database.transaction(true, () => { database.statement('UPDATE span_search_meta SET dirty = 1 WHERE id = 1').run(); });
	index.initialize();
	assert.equal(queries.retrieve({ projectId: 'project' }, planLogQuery('beforeupgrade'), 8).matchedSpans, 0);
	assert.equal(queries.retrieve({ projectId: 'project' }, planLogQuery('afterupgrade'), 8).matchedSpans, 1);
});

test('Unicode-heavy labels and excerpts remain bounded valid evidence', async (context) => {
	const { repository, queries } = await store(context);
	const unicode = String.fromCodePoint(0x1f600);
	const span = prepared({ attributes: { 'tool.name': unicode.repeat(200), output: `${unicode.repeat(2000)} uniquecontent` } });
	repository.ingest([span], span.span.startedAt);
	const result = queries.retrieve({ projectId: 'project' }, planLogQuery('uniquecontent'), 8);
	assert.equal(result.evidence.length, 1);
	assert.ok(result.evidence[0]!.excerpt.length <= 6000);
	assert.equal(result.tools[0]?.name, 'read_file');
});

test('query admission windows expire independently and bound tracked credential state', () => {
	let clock = Date.parse('2026-10-20T00:00:00.000Z');
	const admission = new LocalLogQueryAdmission(() => new Date(clock));
	for (let index = 0; index < 30; index += 1) { admission.admit('reader'); }
	assert.throws(() => admission.admit('reader'), /30 per credential/);
	clock += 60_000;
	assert.doesNotThrow(() => admission.admit('reader'));
	for (let index = 0; index < 1023; index += 1) { admission.admit(`reader-${index}`); }
	assert.throws(() => admission.admit('overflow'), /30 per credential/);
	clock += 60_000;
	assert.doesNotThrow(() => admission.admit('overflow'));
});

test('conversational retrieval prioritizes captured replies and expands context without crossing projects', async (context) => {
	const { repository, queries } = await store(context);
	const first = prepared({ kind: 'agent', name: 'review', attributes: { input: { message: 'Review inventory' } } });
	repository.ingest([first, prepared({ spanId: '2'.repeat(16), kind: 'custom', name: 'agent.message', attributes: { 'message.role': 'assistant', 'source.kind': 'agent.message', output: 'The spring discount is 15 percent.' } }), prepared({ projectId: 'other', attributes: { output: 'Private other-project answer.' } })], first.span.startedAt);
	const plan = { ...planLogQuery('What did it answer?'), contextual: true };
	const result = queries.retrieve({ projectId: 'project' }, plan, 8);
	assert.equal(result.strategy, 'contextual-spans');
	assert.equal(result.evidence[0]?.name, 'agent.message');
	assert.match(result.evidence[0]!.excerpt, /spring discount/);
	assert.ok(result.evidence.every((source) => source.projectId === 'project'));
	const expanded = queries.retrieve({ projectId: 'project' }, { intent: 'search', terms: ['unmatchedword'], contextual: true }, 8);
	assert.equal(expanded.matchedSpans, 0);
	assert.equal(expanded.contextExpanded, true);
	assert.equal(expanded.evidence.length, 2);
});

test('overview preserves unknown usage and deduplicates reported model requests without counting tool usage', async (context) => {
	const { repository, queries } = await store(context);
	const model = prepared({ kind: 'model', name: 'model', usage: { source: 'provider-reported', provider: 'example', model: 'actual-model', requestId: 'shared', totalTokens: 12 } });
	repository.ingest([{ ...model, usageKey: 'shared' }, { ...prepared({ ...model.span, spanId: '2'.repeat(16) }), usageKey: 'shared' }, prepared({ spanId: '3'.repeat(16), kind: 'model', name: 'unknown' }), prepared({ spanId: '4'.repeat(16), usage: { source: 'adapter-reported', model: 'tool-not-model', totalTokens: 999 } })], model.span.startedAt);
	const result = queries.retrieve({ projectId: 'project' }, { intent: 'search', terms: [], focus: 'usage', contextual: true }, 8);
	assert.equal(result.overview?.reportedTokens, 12);
	assert.equal(result.overview?.modelSpans, 3);
	assert.equal(result.overview?.reportedModelSpans, 2);
	assert.equal(result.overview?.usageComplete, false);
	assert.deepEqual(result.overview?.models, ['actual-model']);
	assert.equal(result.evidence[0]?.kind, 'model');
});

test('conversational file questions retain broader context even when a run contains many repeated tools', async (context) => {
	const { repository, queries } = await store(context);
	const root = prepared({ kind: 'agent', name: 'review', attributes: { input: { message: 'Investigate negative inventory quantities.' } } });
	const tools = Array.from({ length: 40 }, (_, index) => prepared({ spanId: (index + 2).toString(16).padStart(16, '0'), attributes: { input: { path: 'src/inventory.ts' } } }));
	repository.ingest([root, ...tools], root.span.startedAt);
	const result = queries.retrieve({ projectId: 'project' }, { ...planLogQuery('Why were those files read?'), contextual: true }, 12);
	assert.equal(result.evidence.length, 12);
	assert.ok(result.evidence.some((source) => source.kind === 'agent' && source.excerpt.includes('negative inventory')));
	assert.equal(result.contextExpanded, true);
	assert.equal(result.totals.toolCalls, 40);
});

test('failed-span evidence includes captured error events even when attributes are empty', async (context) => {
	const { repository, queries } = await store(context);
	const first = prepared({ state: 'failed', attributes: {}, events: [{ name: 'exception', at: '2026-10-13T00:00:00.000Z', attributes: { 'exception.message': 'Inventory database is unavailable.' } }] });
	repository.ingest([first], first.span.startedAt);
	const result = queries.retrieve({ projectId: 'project' }, planLogQuery('What failed?'), 8);
	assert.match(result.evidence[0]!.excerpt, /Inventory database is unavailable/);
});

test('reply retrieval prioritizes an agent result and keeps output ahead of a long captured input', async (context) => {
	const { repository, queries } = await store(context);
	const root = prepared({ kind: 'agent', name: 'review', attributes: { input: 'x'.repeat(10_000), output: 'The final review found a missing stock check.' } });
	const tool = prepared({ spanId: '2'.repeat(16), kind: 'tool', name: 'read_file', startedAt: '2026-10-13T00:00:01.000Z', endedAt: '2026-10-13T00:00:02.000Z', attributes: { output: 'A file read is not the agent answer.' } });
	repository.ingest([root, tool], root.span.startedAt);
	const result = queries.retrieve({ projectId: 'project' }, { ...planLogQuery('What did it answer?'), contextual: true }, 1);
	assert.equal(result.evidence[0]?.kind, 'agent');
	assert.match(result.evidence[0]!.excerpt, /final review found/);
	assert.equal(result.evidence[0]?.excerptTruncated, true);
});

test('conversational file questions retain an explicitly named older path ahead of repeated recent reads', async (context) => {
	const { repository, queries } = await store(context);
	const target = prepared({ attributes: { input: { path: 'src/pricing.ts' }, output: 'Discount validation source.' } });
	const recent = Array.from({ length: 30 }, (_, index) => prepared({ spanId: (index + 2).toString(16).padStart(16, '0'), startedAt: '2026-10-13T00:00:01.000Z', endedAt: '2026-10-13T00:00:02.000Z', attributes: { input: { path: 'src/inventory.ts' } } }));
	repository.ingest([target, ...recent], target.span.startedAt);
	const result = queries.retrieve({ projectId: 'project' }, { ...planLogQuery('Which files were read at src/pricing.ts?'), contextual: true }, 3);
	assert.equal(result.evidence[0]?.spanId, target.span.spanId);
	assert.match(result.evidence[0]!.excerpt, /pricing/);
	assert.equal(result.totals.toolCalls, 31);
});
