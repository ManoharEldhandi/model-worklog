import type { LogQueryEvidence, LogQueryResponse, LogQueryScope, LogQueryTotals, LogSynthesisResult, LogToolUsage } from 'model-worklog-schema';

import type { LogQueryPlan } from './queryPlanner';

export interface LogQuerySnapshot {
	readonly totals: LogQueryTotals;
	readonly tools: readonly LogToolUsage[];
	readonly evidence: readonly LogQueryEvidence[];
	readonly matchedSpans: number;
	readonly toolsTruncated: boolean;
	readonly strategy: LogQueryResponse['retrieval']['strategy'];
}

export interface LogQueryRepository {
	retrieve(scope: Readonly<LogQueryScope>, plan: LogQueryPlan, limit: number): LogQuerySnapshot;
}

export interface LogQueryAdmission {
	admit(principalId: string): void;
}

export interface LogAnswerGenerator {
	generate(question: string, evidence: Readonly<LogQueryResponse>, signal: AbortSignal): Promise<LogSynthesisResult>;
}

export interface SpanPersistenceInterceptor {
	beforeSpanWrite(projectId: string, traceId: string, spanId: string): void;
	afterSpanWrite(projectId: string, traceId: string, spanId: string): void;
	beforeTraceDelete(projectId: string, traceId: string): void;
}
