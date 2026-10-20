import { z } from 'zod';

import { CaptureReportSchema, ProjectIdSchema, SpanIdSchema, SpanKindSchema, SpanUsageSchema, TraceIdSchema, TraceStateSchema } from './trace';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const LogQueryScopeSchema = z.strictObject({
	projectId: ProjectIdSchema,
	traceId: TraceIdSchema.optional(),
	toolName: z.string().trim().min(1).max(256).optional(),
	since: z.iso.datetime().optional(),
	until: z.iso.datetime().optional(),
});

export const LogConversationMessageSchema = z.strictObject({
	role: z.enum(['user', 'assistant']),
	content: z.string().trim().min(1).max(4_000),
});

export const LogQueryRequestSchema = LogQueryScopeSchema.extend({
	schemaVersion: z.literal(1).default(1),
	question: z.string().trim().min(1).max(2_000),
	history: z.array(LogConversationMessageSchema).max(12).default([]),
	intent: z.enum(['auto', 'tools', 'failures', 'search']).default('auto'),
	synthesis: z.enum(['extractive', 'model']).default('extractive'),
	limit: z.number().int().min(1).max(20).default(8),
}).refine((value) => value.since === undefined || value.until === undefined || Date.parse(value.since) <= Date.parse(value.until), 'since must not follow until')
	.refine((value) => value.history.reduce((total, message) => total + message.content.length, 0) <= 16_000, 'Conversation history exceeds 16000 characters');

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
	endedAt: z.iso.datetime().optional(),
	usage: SpanUsageSchema.optional(),
	excerpt: z.string().max(6_000),
	excerptTruncated: z.boolean().default(false),
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

export const LogQueryOverviewSchema = z.strictObject({
	firstSeen: z.iso.datetime().nullable().default(null),
	lastSeen: z.iso.datetime().nullable().default(null),
	models: z.array(z.string().min(1).max(128)).max(100).default([]),
	services: z.array(z.string().min(1).max(128)).max(100).default([]),
	modelSpans: count.default(0),
	reportedModelSpans: count.default(0),
	reportedTokens: count.optional(),
	usageComplete: z.boolean().default(false),
});

export const LogQueryResponseSchema = z.strictObject({
	schemaVersion: z.literal(1),
	intent: z.enum(['tools', 'failures', 'search']),
	answer: z.string().min(1).max(16_000),
	question: z.string().max(2_000).optional(),
	scope: LogQueryScopeSchema,
	snapshotAt: z.iso.datetime(),
	totals: LogQueryTotalsSchema,
	overview: LogQueryOverviewSchema.default({ firstSeen: null, lastSeen: null, models: [], services: [], modelSpans: 0, reportedModelSpans: 0, usageComplete: false }),
	aggregateSource: z.strictObject({ id: z.literal('A1'), label: z.literal('Exact scoped aggregates') }).default({ id: 'A1', label: 'Exact scoped aggregates' }),
	tools: z.array(LogToolUsageSchema).max(100),
	evidence: z.array(LogQueryEvidenceSchema).max(20),
	retrieval: z.strictObject({
		strategy: z.enum(['exact-aggregate', 'sqlite-fts5', 'sqlite-scan', 'failed-spans', 'recent-spans', 'contextual-spans']),
		matchedSpans: count,
		returnedSpans: count,
		truncated: z.boolean(),
		toolsTruncated: z.boolean(),
		contextExpanded: z.boolean().default(false),
	}),
	limitations: z.array(z.string().max(512)).max(16),
	generation: z.strictObject({
		mode: z.enum(['extractive', 'model']),
		model: z.string().min(1).max(128).optional(),
		status: z.enum(['local', 'generated', 'fallback']),
		provider: z.string().min(1).max(128).optional(),
	}).default({ mode: 'extractive', status: 'local' }),
});

export const LogSynthesisResultSchema = z.strictObject({
	answer: z.string().trim().min(1).max(8_000),
	sourceIds: z.array(z.string().regex(/^(?:S[1-9][0-9]*|A1)$/)).max(21),
});

export type LogConversationMessage = z.infer<typeof LogConversationMessageSchema>;
export type LogQueryScope = z.infer<typeof LogQueryScopeSchema>;
export type LogQueryRequest = z.infer<typeof LogQueryRequestSchema>;
export type LogToolUsage = z.infer<typeof LogToolUsageSchema>;
export type LogQueryEvidence = z.infer<typeof LogQueryEvidenceSchema>;
export type LogQueryTotals = z.infer<typeof LogQueryTotalsSchema>;
export type LogQueryOverview = z.infer<typeof LogQueryOverviewSchema>;
export type LogQueryResponse = z.infer<typeof LogQueryResponseSchema>;
export type LogSynthesisResult = z.infer<typeof LogSynthesisResultSchema>;
