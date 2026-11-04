import { createHash } from 'node:crypto';
import { StoredTraceSpanSchema, redactAttributes, redactSensitiveText, type StoredTraceSpan } from 'model-worklog-schema';
import type { LogRagChunk } from './types';

export const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
export function normalizeVector(values: readonly number[]): number[] {
	if (values.length === 0 || values.length > 4096 || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) { throw new Error('Invalid embedding dimensions or values.'); }
	const norm = Math.hypot(...values);
	if (!Number.isFinite(norm) || norm === 0) { throw new Error('A nonzero finite embedding is required.'); }
	return values.map((value) => value / norm);
}

export function chunkSpans(records: readonly StoredTraceSpan[]): LogRagChunk[] {
	return records.flatMap((record) => {
		const { span } = StoredTraceSpanSchema.parse(record);
		let sourceShortened = false;
		const label = (value: string, limit: number): string => { const redacted = redactSensitiveText(value); sourceShortened ||= redacted.length > limit; return redacted.slice(0, limit); };
		const policy = { mode: span.capture.mode };
		const clean = redactAttributes(span.attributes, policy);
		const events = span.events.map((event) => ({ name: redactSensitiveText(event.name), at: event.at, attributes: redactAttributes(event.attributes, policy).attributes }));
		const { output, content, input, ...attributes } = clean.attributes;
		const name = label(span.name, 256); const service = label(span.serviceName, 128);
		const header = `${name} | ${span.kind} | ${service}\n`.slice(0, 250);
		const sections = [output === undefined ? '' : `output: ${JSON.stringify(output)}`, content === undefined ? '' : `content: ${JSON.stringify(content)}`,
			input === undefined ? '' : `input: ${JSON.stringify(input)}`, `attributes: ${JSON.stringify(attributes)}`, events.length === 0 ? '' : `events: ${JSON.stringify(events)}`].filter(Boolean);
		const queues = sections.map((section) => { const items: string[] = []; for (let offset = 0; offset < section.length && items.length < 16; offset += 1400) { items.push(header + section.slice(offset, offset + 1500)); } return items; });
		const texts: string[] = [];
		while (texts.length < 8 && queues.some((queue) => queue.length > 0)) { for (const queue of queues) { const text = queue.shift(); if (text !== undefined) { texts.push(text); if (texts.length === 8) { break; } } } }
		const source = { projectId: span.projectId, traceId: span.traceId, spanId: span.spanId, revision: span.revision, name, kind: span.kind, state: span.state, startedAt: span.startedAt,
			capture: { ...span.capture, limitations: span.capture.limitations.map((value) => label(value, 256)), redactedFields: span.capture.redactedFields + clean.report.redactedFields }, evidenceGrade: 'model-declared' as const,
			...(span.kind === 'tool' ? { toolName: label(typeof clean.attributes['tool.name'] === 'string' ? clean.attributes['tool.name'] : name, 256) } : {}),
			...(span.usage === undefined ? {} : { usage: { ...span.usage, ...(span.usage.provider === undefined ? {} : { provider: label(span.usage.provider, 128) }), ...(span.usage.model === undefined ? {} : { model: label(span.usage.model, 128) }), ...(span.usage.requestId === undefined ? {} : { requestId: label(span.usage.requestId, 256) }) } }) };
		const shortened = sourceShortened || queues.some((queue) => queue.length > 0) || sections.some((section) => section.length > 22400) || clean.report.truncatedFields > 0 || span.capture.truncatedFields > 0;
		const spanHash = hash(JSON.stringify({ source, texts }));
		return texts.map((text, chunkIndex) => ({ id: hash(JSON.stringify([span.projectId, span.traceId, span.spanId, span.revision, chunkIndex, spanHash])), text, contentHash: hash(text), spanHash, chunkIndex, chunkCount: texts.length, shortened, source }));
	});
}
