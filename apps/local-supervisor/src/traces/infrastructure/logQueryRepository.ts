import type { SQLInputValue, SQLOutputValue } from 'node:sqlite';

import {
	LogQueryEvidenceSchema, LogQueryTotalsSchema, LogToolUsageSchema,
	type LogQueryEvidence, type LogQueryScope, type LogQueryTotals, type LogToolUsage,
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
		startedAt: text(row, 'started_at'), excerpt: text(row, 'excerpt').slice(0, 1_600), evidenceGrade: 'model-declared',
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
			const useSearch = plan.intent === 'search' && plan.terms.length > 0;
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
			const excerpt = useFts ? "substr(snippet(span_search, 0, '', '', ' ... ', 40), 1, 1600)"
				: useSearch ? `substr(s.payload, max(1, (${position}) - 200), 1600)` : "substr(json_extract(s.payload, '$.attributes'), 1, 1600)";
			const excerptValues = useSearch && !useFts ? plan.terms.flatMap((term) => [term, term]) : [];
			const order = useFts ? 'bm25(span_search), s.sequence DESC' : `${startedTime} DESC, s.sequence DESC`;
			const rows = this.database.statement(`SELECT s.sequence, s.project_id, s.trace_id, s.span_id, s.revision, s.state,
				json_extract(s.payload, '$.name') AS name, json_extract(s.payload, '$.serviceName') AS service_name,
				${kind} AS kind, ${startedAt} AS started_at, json_extract(s.payload, '$.capture') AS capture,
				${excerpt} AS excerpt FROM ${from} WHERE ${where} ORDER BY ${order} LIMIT ?`).all(...excerptValues, ...values, limit);
			return Object.freeze({
				totals: Object.freeze(totals), tools: Object.freeze(tools.slice(0, 100)), evidence: Object.freeze(rows.map(evidence)),
				matchedSpans, toolsTruncated: tools.length > 100,
				strategy: useSearch ? useFts ? 'sqlite-fts5' : 'sqlite-scan' : plan.intent === 'tools' ? 'exact-aggregate' : plan.intent === 'failures' ? 'failed-spans' : 'recent-spans',
			});
		});
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
