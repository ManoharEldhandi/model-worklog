import { z } from 'zod';

import type { JsonValue } from './events';

export function isBoundedJson(input: unknown): input is JsonValue {
	const pending: { value: unknown; depth: number }[] = [{ value: input, depth: 0 }];
	const seen = new WeakSet<object>();
	let nodes = 0;
	while (pending.length > 0) {
		const entry = pending.pop();
		if (entry === undefined || ++nodes > 20_000 || entry.depth > 16) { return false; }
		const value = entry.value;
		if (value === null || typeof value === 'boolean') { continue; }
		if (typeof value === 'string') { if (value.length > 16_000) { return false; } continue; }
		if (typeof value === 'number') { if (!Number.isFinite(value)) { return false; } continue; }
		if (typeof value !== 'object' || seen.has(value)) { return false; }
		seen.add(value);
		if (Array.isArray(value)) {
			if (value.length > 1_000) { return false; }
			for (const element of value) { pending.push({ value: element, depth: entry.depth + 1 }); }
			continue;
		}
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) { return false; }
		const descriptors = Object.getOwnPropertyDescriptors(value);
		if (Object.keys(descriptors).length > 128) { return false; }
		for (const [key, descriptor] of Object.entries(descriptors)) {
			if (key.length > 256 || ['__proto__', 'prototype', 'constructor'].includes(key) || !('value' in descriptor)) { return false; }
			pending.push({ value: descriptor.value as unknown, depth: entry.depth + 1 });
		}
	}
	return true;
}

export const ProjectIdSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/);
export const TraceIdSchema = z.string().regex(/^(?!0{32}$)[a-f0-9]{32}$/);
export const SpanIdSchema = z.string().regex(/^(?!0{16}$)[a-f0-9]{16}$/);
export const TraceAttributesSchema = z.record(z.string().min(1).max(256), z.custom<JsonValue>(isBoundedJson)).refine((value) => Object.keys(value).length <= 128 && isBoundedJson(value), 'Attributes exceed JSON limits');
export const SpanKindSchema = z.enum(['agent', 'model', 'tool', 'retrieval', 'embedding', 'rerank', 'memory', 'workflow', 'custom']);
export const TraceStateSchema = z.enum(['running', 'completed', 'failed', 'interrupted']);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const SpanUsageSchema = z.strictObject({
	source: z.enum(['provider-reported', 'computed-from-provider-fields', 'adapter-reported']),
	provider: z.string().min(1).max(128).optional(),
	model: z.string().min(1).max(128).optional(),
	requestId: z.string().min(1).max(256).optional(),
	inputTokens: count.optional(), outputTokens: count.optional(), totalTokens: count.optional(),
	cacheReadTokens: count.optional(), cacheWriteTokens: count.optional(), reasoningTokens: count.optional(),
}).refine((value) => value.totalTokens !== undefined || value.inputTokens !== undefined || value.outputTokens !== undefined, 'At least one token count is required')
	.refine((value) => value.reasoningTokens === undefined || value.outputTokens === undefined || value.reasoningTokens <= value.outputTokens, 'Reasoning tokens cannot exceed output tokens');

export const CaptureReportSchema = z.strictObject({
	mode: z.enum(['metadata', 'redacted-content']),
	redactedFields: count, truncatedFields: count, droppedEvents: count,
	limitations: z.array(z.string().max(256)).max(32),
});

export const SpanLinkSchema = z.strictObject({ traceId: TraceIdSchema, spanId: SpanIdSchema });
export const SpanEventSchema = z.strictObject({
	name: z.string().min(1).max(256), at: z.iso.datetime(), attributes: TraceAttributesSchema,
});

export const TraceSpanSchema = z.strictObject({
	schemaVersion: z.literal(1), projectId: ProjectIdSchema,
	traceId: TraceIdSchema, spanId: SpanIdSchema, parentSpanId: SpanIdSchema.optional(),
	name: z.string().min(1).max(256), serviceName: z.string().min(1).max(128), kind: SpanKindSchema,
	startedAt: z.iso.datetime(), endedAt: z.iso.datetime().optional(), state: TraceStateSchema,
	revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	attributes: TraceAttributesSchema, events: z.array(SpanEventSchema).max(128), links: z.array(SpanLinkSchema).max(128),
	usage: SpanUsageSchema.optional(), capture: CaptureReportSchema,
}).superRefine((value, context) => {
	if ((value.state === 'running') !== (value.endedAt === undefined)) { context.addIssue({ code: 'custom', message: 'Only running spans may omit endedAt' }); }
	if (value.endedAt !== undefined && Date.parse(value.endedAt) < Date.parse(value.startedAt)) { context.addIssue({ code: 'custom', message: 'endedAt precedes startedAt' }); }
	if (value.parentSpanId === value.spanId) { context.addIssue({ code: 'custom', message: 'A span cannot be its own parent' }); }
});

export const TraceBatchSchema = z.strictObject({ schemaVersion: z.literal(1), spans: z.array(TraceSpanSchema).min(1).max(100) });
export const TraceBatchAckSchema = z.strictObject({ schemaVersion: z.literal(1), accepted: count, duplicates: count });
export const TraceRoleSchema = z.enum(['writer', 'reader', 'admin']);
export const TracePrincipalSchema = z.strictObject({
	id: z.string().min(1).max(128), role: TraceRoleSchema,
	projects: z.array(z.union([ProjectIdSchema, z.literal('*')])).min(1).max(100),
	expiresAt: z.iso.datetime().optional(),
});
export const CreateTraceCredentialSchema = z.strictObject({
	role: z.enum(['writer', 'reader']), projects: z.array(ProjectIdSchema).min(1).max(100),
	ttlSeconds: z.number().int().min(60).max(31_536_000).default(86_400),
});
export const StoredTraceSpanSchema = z.strictObject({
	span: TraceSpanSchema, receivedAt: z.iso.datetime(), sequence: count,
	evidenceGrade: z.literal('model-declared'),
});
export const TraceSummarySchema = z.strictObject({
	projectId: ProjectIdSchema, traceId: TraceIdSchema, name: z.string().max(256), serviceName: z.string().max(128),
	state: TraceStateSchema, startedAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
	spanCount: count, totalTokens: count.optional(), incomplete: z.boolean(),
});
export const TraceListSchema = z.strictObject({ schemaVersion: z.literal(1), traces: z.array(TraceSummarySchema).max(100), nextCursor: z.string().nullable() });
export const TraceDetailSchema = z.strictObject({ schemaVersion: z.literal(1), spans: z.array(StoredTraceSpanSchema).max(1_000), nextCursor: z.string().nullable() });

export type TraceSpan = z.infer<typeof TraceSpanSchema>;
export type TraceBatch = z.infer<typeof TraceBatchSchema>;
export type TraceBatchAck = z.infer<typeof TraceBatchAckSchema>;
export type TracePrincipal = z.infer<typeof TracePrincipalSchema>;
export type TraceRole = z.infer<typeof TraceRoleSchema>;
export type SpanKind = z.infer<typeof SpanKindSchema>;
export type SpanUsage = z.infer<typeof SpanUsageSchema>;
export type CaptureReport = z.infer<typeof CaptureReportSchema>;
export type SpanEvent = z.infer<typeof SpanEventSchema>;
export type SpanLink = z.infer<typeof SpanLinkSchema>;
export type TraceSummary = z.infer<typeof TraceSummarySchema>;
export type StoredTraceSpan = z.infer<typeof StoredTraceSpanSchema>;