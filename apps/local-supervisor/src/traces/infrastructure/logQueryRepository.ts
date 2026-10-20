import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

import {
	LogQueryEvidenceSchema, LogQueryTotalsSchema, LogToolUsageSchema,
	type LogQueryEvidence, type LogQueryOverview, type LogQueryScope, type LogQueryTotals, type LogToolUsage,
} from 'model-worklog-schema';

import type { LogQueryRepository, LogQuerySnapshot } from '../domain/logQuery';
import type { LogQueryPlan } from '../domain/queryPlanner';
import { TraceDatabase, integer, text } from './database';
import { hasSqliteFts5 } from './logSearchIndex';

const kind = "json_extract(s.payload, '$.kind')";
const startedAt = "json_extract(s.payload, '$.startedAt')";
const startedTime = `julianday(${startedAt})`;
const toolName = `CASE WHEN json_type(s.payload, '$.attributes."tool.name"') = 'text'
	AND length(CAST(json_extract(s.payload, '$.attributes."tool.name"') AS BLOB)) BETWEEN 1 AND 256
	THEN json_extract(s.payload, '$.attributes."tool.name"') ELSE json_extract(s.payload, '$.name') END`;

interface SqlScope {
	readonly where: string;
	readonly values: readonly SQLInputValue[];
}

function sqlScope(scope: Readonly<LogQueryScope>): SqlScope {
	const conditions = ['s.project_id = ?'];
	const values: SQLInputValue[] = [scope.projectId];
	if (scope.traceId !== undefined) { conditions.push('s.trace_id = ?'); values.push(scope.traceId); }
	if (scope.toolName !== undefined) { conditions.push(`${kind} = 'tool' AND ${toolName} = ? COLLATE NOCASE`); values.push(scope.toolName); }
	if (scope.since !== undefined) { conditions.push(`${startedTime} >= julianday(?)`); values.push(scope.since); }
	if (scope.until !== undefined) { conditions.push(`${startedTime} <= julianday(?)`); values.push(scope.until); }
	return { where: conditions.join(' AND '), values };
}

function evidence(row: Record<string, SQLOutputValue>, index: number): LogQueryEvidence {
	return LogQueryEvidenceSchema.parse({
		id: `S${index + 1}`, projectId: text(row, 'project_id'), traceId: text(row, 'trace_id'), spanId: text(row, 'span_id'),
		sequence: integer(row, 'sequence'), revision: integer(row, 'revision'), name: text(row, 'name'),
		serviceName: text(row, 'service_name'), kind: text(row, 'kind'), state: text(row, 'state'),
		startedAt: text(row, 'started_at'), endedAt: typeof row.ended_at === 'string' ? row.ended_at : undefined,
		usage: typeof row.usage === 'string' ? JSON.parse(row.usage) as unknown : undefined,
		excerpt: text(row, 'excerpt').slice(0, 6_000), excerptTruncated: text(row, 'excerpt').length > 6_000 || row.excerpt_shortened === 1, evidenceGrade: 'model-declared',
		capture: JSON.parse(text(row, 'capture')) as unknown,
	});
}

export class SqliteLogQueryRepository implements LogQueryRepository {
	private readonly fullText: boolean;
	constructor(private readonly database: TraceDatabase) { this.fullText = hasSqliteFts5(database); }

	retrieve(scope: Readonly<LogQueryScope>, plan: LogQueryPlan, limit: number): LogQuerySnapshot {
		return this.database.transaction(false, () => {
			const selected = sqlScope(scope);
			const totals = this.totals(selected);
			const tools = this.tools(selected);
			const focused = plan.contextual === true && plan.focus !== undefined;
			const useSearch = plan.intent === 'search' && plan.terms.length > 0 && !focused;
			const useFts = useSearch && this.fullText;
			const from = useFts ? 'span_search JOIN spans s ON s.sequence = span_search.rowid' : 'spans s';
			const filter = useSearch
				? useFts ? 'span_search MATCH ? AND ' : `(${plan.terms.map(() => 'instr(lower(s.payload), ?) > 0').join(' OR ')}) AND `
				: plan.intent === 'tools' ? `${kind} = 'tool' AND ` : plan.intent === 'failures' ? "s.state = 'failed' AND " : '';
			const searchValues = useFts ? [plan.terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ')] : useSearch ? [...plan.terms] : [];
			const values = [...searchValues, ...selected.values];
			const where = `${filter}${selected.where}`;
			const matchedSpans = integer(this.database.statement(`SELECT COUNT(*) AS count FROM ${from} WHERE ${where}`).get(...values), 'count');
			const positions = plan.terms.map(() => 'CASE WHEN instr(lower(s.payload), ?) > 0 THEN instr(lower(s.payload), ?) ELSE 2147483647 END');
			const position = positions.length === 1 ? positions[0] : `min(${positions.join(', ')})`;
			const excerpt = useFts ? "substr(snippet(span_search, 0, '', '', ' ... ', 120), 1, 6000)"
				: useSearch ? `substr(s.payload, max(1, (${position}) - 200), 6000)` : "substr(json_extract(s.payload, '$.attributes'), 1, 6000)";
			const excerptValues = useSearch && !useFts ? plan.terms.flatMap((term) => [term, term]) : [];
			const order = useFts ? 'bm25(span_search), s.sequence DESC' : this.contextOrder(plan);
			const primaryLimit = plan.contextual === true ? Math.max(1, limit - Math.floor(limit / 3)) : limit;
			let rows = this.database.statement(`SELECT ${this.evidenceColumns()}, ${excerpt} AS excerpt,
				length(json_extract(s.payload, '$.attributes')) > 6000 AS excerpt_shortened
				FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ?`).all(...excerptValues, ...values, primaryLimit);
			let contextExpanded = focused;
			if (plan.contextual === true && rows.length < limit) {
				const context = this.database.statement(`SELECT ${this.evidenceColumns()}, substr(json_extract(s.payload, '$.attributes'), 1, 6000) AS excerpt,
					length(json_extract(s.payload, '$.attributes')) > 6000 AS excerpt_shortened FROM spans s WHERE ${selected.where}
					ORDER BY ${this.contextOrder({ ...plan, focus: 'overview' })} LIMIT ?`).all(...selected.values, limit);
				const seen = new Set(rows.map((row) => integer(row, 'sequence')));
				const additional = context.filter((row) => !seen.has(integer(row, 'sequence'))).slice(0, limit - rows.length);
				rows = [...rows, ...additional];
				contextExpanded ||= additional.length > 0;
			}
			return Object.freeze({
				totals: Object.freeze(totals), tools: Object.freeze(tools.slice(0, 100)), evidence: Object.freeze(rows.map(evidence)),
				matchedSpans, toolsTruncated: tools.length > 100, contextExpanded, overview: Object.freeze(this.overview(selected)),
				strategy: focused && plan.intent === 'search' ? 'contextual-spans' : useSearch ? useFts ? 'sqlite-fts5' : 'sqlite-scan' : plan.intent === 'tools' ? 'exact-aggregate' : plan.intent === 'failures' ? 'failed-spans' : 'recent-spans',
			});
		});
	}

	private evidenceColumns(): string {
		return `s.sequence, s.project_id, s.trace_id, s.span_id, s.revision, s.state,
			json_extract(s.payload, '$.name') AS name, json_extract(s.payload, '$.serviceName') AS service_name,
			${kind} AS kind, ${startedAt} AS started_at, json_extract(s.payload, '$.endedAt') AS ended_at,
			json_extract(s.payload, '$.usage') AS usage, json_extract(s.payload, '$.capture') AS capture`;
	}

	private contextOrder(plan: LogQueryPlan): string {
		const role = `json_extract(s.payload, '$.attributes."message.role"')`;
		const source = `json_extract(s.payload, '$.attributes."source.kind"')`;
		if (plan.focus === 'request') { return `CASE WHEN ${role} = 'user' THEN 0 WHEN ${kind} = 'agent' THEN 1 ELSE 2 END, ${startedTime}, s.sequence`; }
		if (plan.focus === 'response') { return `CASE WHEN ${role} = 'assistant' THEN 0 WHEN ${kind} = 'model' THEN 1 ELSE 2 END, ${startedTime} DESC, s.sequence DESC`; }
		if (plan.focus === 'usage') { return `CASE WHEN ${kind} = 'model' THEN 0 WHEN ${source} = 'usage.reported' THEN 1 ELSE 2 END, ${startedTime} DESC, s.sequence DESC`; }
		if (plan.focus === 'files') { return `CASE WHEN ${source} = 'file.read' OR ${source} = 'file.changed' THEN 0 WHEN ${kind} = 'tool' THEN 1 ELSE 2 END, ${startedTime} DESC, s.sequence DESC`; }
		if (plan.focus === 'timeline') { return `${startedTime}, s.sequence`; }
		if (plan.focus === 'overview') { return `ROW_NUMBER() OVER (PARTITION BY COALESCE(${source}, ${kind}) ORDER BY ${startedTime} DESC, s.sequence DESC), CASE WHEN ${kind} IN ('agent', 'model') THEN 0 ELSE 1 END, ${startedTime} DESC, s.sequence DESC`; }
		return `${startedTime} DESC, s.sequence DESC`;
	}

	private overview(scope: SqlScope): LogQueryOverview {
		const usage = `json_extract(s.payload, '$.usage')`;
		const row = this.database.statement(`SELECT strftime('%Y-%m-%dT%H:%M:%fZ', MIN(${startedTime})) AS first_seen,
			strftime('%Y-%m-%dT%H:%M:%fZ', MAX(julianday(COALESCE(json_extract(s.payload, '$.endedAt'), ${startedAt})))) AS last_seen,
			COALESCE(SUM(${kind} = 'model'), 0) AS model_spans,
			COALESCE(SUM(${kind} = 'model' AND s.state != 'running' AND ${usage} IS NOT NULL), 0) AS reported_spans
			FROM spans s WHERE ${scope.where}`).get(...scope.values);
		const token = `COALESCE(json_extract(s.payload, '$.usage.totalTokens'),
			CASE WHEN ${usage} IS NOT NULL THEN COALESCE(json_extract(s.payload, '$.usage.inputTokens'), 0) + COALESCE(json_extract(s.payload, '$.usage.outputTokens'), 0) END)`;
		const complete = `(json_extract(s.payload, '$.usage.totalTokens') IS NOT NULL OR (json_extract(s.payload, '$.usage.inputTokens') IS NOT NULL AND json_extract(s.payload, '$.usage.outputTokens') IS NOT NULL))`;
		const tokens = this.database.statement(`WITH requests AS (
			SELECT MAX(${token}) AS tokens, MIN(${complete}) AS complete, COUNT(DISTINCT ${token}) > 1 AS conflict
			FROM spans s WHERE ${scope.where} AND ${kind} = 'model' AND s.state != 'running'
			GROUP BY s.trace_id, COALESCE('usage:' || json_extract(s.summary_input, '$.usageKey'), 'span:' || s.sequence)
		) SELECT SUM(CAST(tokens AS REAL)) AS reported_tokens, COALESCE(MIN(complete), 0) AS complete, COALESCE(MAX(conflict), 0) AS conflict FROM requests`).get(...scope.values);
		const reportedTokens = typeof tokens?.reported_tokens === 'number' && Number.isSafeInteger(tokens.reported_tokens) ? tokens.reported_tokens : undefined;
		return {
			firstSeen: typeof row?.first_seen === 'string' ? row.first_seen : null, lastSeen: typeof row?.last_seen === 'string' ? row.last_seen : null,
			models: this.names(scope, `CASE WHEN ${kind} = 'model' THEN COALESCE(json_extract(s.payload, '$.usage.model'), json_extract(s.payload, '$.attributes."model.name"'), json_extract(s.payload, '$.attributes."gen_ai.response.model"'), json_extract(s.payload, '$.attributes."gen_ai.request.model"')) END`),
			services: this.names(scope, "json_extract(s.payload, '$.serviceName')"),
			modelSpans: integer(row, 'model_spans'), reportedModelSpans: integer(row, 'reported_spans'),
			...(reportedTokens === undefined ? {} : { reportedTokens }),
			usageComplete: integer(row, 'model_spans') > 0 && integer(row, 'model_spans') === integer(row, 'reported_spans') && reportedTokens !== undefined && tokens?.complete === 1 && tokens.conflict === 0,
		};
	}

	private names(scope: SqlScope, expression: string): string[] {
		return this.database.statement(`SELECT DISTINCT ${expression} AS name FROM spans s WHERE ${scope.where} AND length(${expression}) > 0 ORDER BY name LIMIT 100`).all(...scope.values).map((row) => text(row, 'name').slice(0, 128));
	}

	private totals(scope: SqlScope): LogQueryTotals {
		const row = this.database.statement(`SELECT COUNT(*) AS spans, COUNT(DISTINCT s.trace_id) AS traces,
			COALESCE(SUM(${kind} = 'tool'), 0) AS tool_calls, COALESCE(SUM(s.state = 'failed'), 0) AS failed_spans,
			COALESCE(SUM(s.state = 'running'), 0) AS running_spans,
			COALESCE(SUM(json_extract(s.payload, '$.capture.mode') = 'metadata'), 0) AS metadata_only,
			COALESCE(SUM(json_extract(s.payload, '$.capture.redactedFields') > 0 OR json_extract(s.payload, '$.capture.truncatedFields') > 0
				OR json_extract(s.payload, '$.capture.droppedEvents') > 0 OR json_array_length(json_extract(s.payload, '$.capture.limitations')) > 0), 0) AS limited_spans
			FROM spans s WHERE ${scope.where}`).get(...scope.values);
		return LogQueryTotalsSchema.parse({
			spans: integer(row, 'spans'), traces: integer(row, 'traces'), toolCalls: integer(row, 'tool_calls'),
			failedSpans: integer(row, 'failed_spans'), runningSpans: integer(row, 'running_spans'),
			metadataOnlySpans: integer(row, 'metadata_only'), limitedSpans: integer(row, 'limited_spans'),
		});
	}

	private tools(scope: SqlScope): LogToolUsage[] {
		return this.database.statement(`SELECT ${toolName} AS tool_name, COUNT(*) AS calls,
			SUM(s.state = 'failed') AS failed, SUM(s.state = 'running') AS running,
			strftime('%Y-%m-%dT%H:%M:%fZ', MIN(${startedTime})) AS first_seen, strftime('%Y-%m-%dT%H:%M:%fZ', MAX(${startedTime})) AS last_seen
			FROM spans s WHERE ${scope.where} AND ${kind} = 'tool' GROUP BY ${toolName}
			ORDER BY calls DESC, tool_name ASC LIMIT 101`).all(...scope.values).map((row) => LogToolUsageSchema.parse({
				name: text(row, 'tool_name'), calls: integer(row, 'calls'), failed: integer(row, 'failed'), running: integer(row, 'running'),
				firstSeen: text(row, 'first_seen'), lastSeen: text(row, 'last_seen'),
			}));
	}
}
