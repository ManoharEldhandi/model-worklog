import { randomBytes } from 'node:crypto';

import { SpanIdSchema, TraceIdSchema } from 'model-worklog-schema';

export interface TraceContext {
	readonly traceId: string;
	readonly spanId: string;
	readonly traceFlags?: number;
	readonly isRemote?: boolean;
}

export function validateContext(context: TraceContext): TraceContext {
	const traceFlags = context.traceFlags ?? 1;
	if (!Number.isInteger(traceFlags) || traceFlags < 0 || traceFlags > 255) { throw new Error('Invalid trace flags.'); }
	return Object.freeze({
		traceId: TraceIdSchema.parse(context.traceId), spanId: SpanIdSchema.parse(context.spanId),
		traceFlags, isRemote: context.isRemote ?? false,
	});
}

export function newContext(parent?: TraceContext): TraceContext {
	return validateContext({ traceId: parent?.traceId ?? randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), traceFlags: parent?.traceFlags ?? 1 });
}

export function parseTraceparent(value: string): TraceContext | undefined {
	if (value.length > 512) { return undefined; }
	const match = /^([a-f0-9]{2})-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})(-\S+)?$/.exec(value);
	if (match === null || match[1] === 'ff' || (match[1] === '00' && match[5] !== undefined)) { return undefined; }
	try {
		return validateContext({ traceId: match[2] ?? '', spanId: match[3] ?? '', traceFlags: Number.parseInt(match[4] ?? '', 16), isRemote: true });
	} catch { return undefined; }
}

export function formatTraceparent(context: TraceContext): string {
	const valid = validateContext(context);
	return `00-${valid.traceId}-${valid.spanId}-${(valid.traceFlags ?? 1).toString(16).padStart(2, '0')}`;
}