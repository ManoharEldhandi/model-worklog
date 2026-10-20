import { z } from 'zod';

import { CaptureReportSchema, ProjectIdSchema, SpanIdSchema, SpanKindSchema, TraceIdSchema, TraceStateSchema } from './trace';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const LogQueryScopeSchema = z.strictObject({
	projectId: ProjectIdSchema,
	traceId: TraceIdSchema.optional(),
	toolName: z.string().trim().min(1).max(256).optional(),
	since: z.iso.datetime().optional(),
	until: z.iso.datetime().optional(),
});

export const LogQueryRequestSchema = LogQueryScopeSchema.extend({
	schemaVersion: z.literal(1).default(1),
	question: z.string().trim().min(1).max(2_000),
	intent: z.enum(['auto', 'tools', 'failures', 'search']).default('auto'),
	synthesis: z.enum(['extractive', 'model']).default('extractive'),
	limit: z.number().int().min(1).max(20).default(8),
}).refine((value) => value.since === undefined || value.until === undefined || Date.parse(value.since) <= Date.parse(value.until), 'since must not follow until');

export const LogToolUsageSchema = z.strictObject({
	name: z.string().min(1).max(256),
	calls: count,
	failed: count,
	running: count,
	firstSeen: z.iso.datetime(),
	lastSeen: z.iso.datetime(),
});

export const LogQueryEvidenceSchema = z.strictObject({
	id: z.string().regex(/^S[1-9][0-9]*$/),
	projectId: ProjectIdSchema,
	traceId: TraceIdSchema,
	spanId: SpanIdSchema,
	sequence: z.number().int().positive(),
	revision: z.number().int().positive(),
	name: z.string().min(1).max(256),
	serviceName: z.string().min(1).max(128),
	kind: SpanKindSchema,
	state: TraceStateSchema,
	startedAt: z.iso.datetime(),
	excerpt: z.string().max(1_600),
	evidenceGrade: z.literal('model-declared'),
	capture: CaptureReportSchema,
});

export const LogQueryTotalsSchema = z.strictObject({
	spans: count,
	traces: count,
	toolCalls: count,
	failedSpans: count,
	runningSpans: count,
	metadataOnlySpans: count,
	limitedSpans: count,
});

export const LogQueryResponseSchema = z.strictObject({
	schemaVersion: z.literal(1),
	intent: z.enum(['tools', 'failures', 'search']),
	answer: z.string().min(1).max(16_000),
	scope: LogQueryScopeSchema,
	snapshotAt: z.iso.datetime(),
	totals: LogQueryTotalsSchema,
	tools: z.array(LogToolUsageSchema).max(100),
	evidence: z.array(LogQueryEvidenceSchema).max(20),
	retrieval: z.strictObject({
		strategy: z.enum(['exact-aggregate', 'sqlite-fts5', 'sqlite-scan', 'failed-spans', 'recent-spans']),
		matchedSpans: count,
		returnedSpans: count,
		truncated: z.boolean(),
		toolsTruncated: z.boolean(),
	}),
	limitations: z.array(z.string().max(512)).max(16),
	generation: z.strictObject({
		mode: z.enum(['extractive', 'model']),
		model: z.string().min(1).max(128).optional(),
		status: z.enum(['local', 'generated', 'fallback']),
	}).default({ mode: 'extractive', status: 'local' }),
});

export const LogSynthesisResultSchema = z.strictObject({
	answer: z.string().trim().min(1).max(8_000),
	sourceIds: z.array(z.string().regex(/^S[1-9][0-9]*$/)).min(1).max(20),
});

export type LogQueryScope = z.infer<typeof LogQueryScopeSchema>;
export type LogQueryRequest = z.infer<typeof LogQueryRequestSchema>;
export type LogToolUsage = z.infer<typeof LogToolUsageSchema>;
export type LogQueryEvidence = z.infer<typeof LogQueryEvidenceSchema>;
export type LogQueryTotals = z.infer<typeof LogQueryTotalsSchema>;
export type LogQueryResponse = z.infer<typeof LogQueryResponseSchema>;
export type LogSynthesisResult = z.infer<typeof LogSynthesisResultSchema>;
