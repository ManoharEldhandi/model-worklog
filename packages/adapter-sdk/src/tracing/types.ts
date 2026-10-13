import type { SpanKind, SpanLink, SpanUsage } from 'model-worklog-schema';

import type { TokenUsageMapping, UsageProviderSelector } from '../usage';
import type { TraceContext } from './context';
import type { TraceProcessorOptions } from './processor';

export interface ModelLoggerOptions extends TraceProcessorOptions {
	readonly projectId: string;
	readonly serviceName: string;
	readonly maxActiveSpans?: number;
}

export interface SpanOptions {
	readonly name: string;
	readonly kind?: SpanKind;
	readonly attributes?: unknown;
	readonly input?: unknown;
	readonly parent?: TraceContext | null;
	readonly links?: readonly SpanLink[];
}

export interface TraceOptions<Result = unknown> extends SpanOptions {
	readonly serializeResult?: (result: Result) => unknown;
}

export interface TraceStreamOptions<Chunk> extends SpanOptions {
	readonly serializeChunk?: (chunk: Chunk) => unknown;
	readonly onChunk?: (chunk: Chunk, span: TraceSpanHandle) => void | Promise<void>;
}

export type TraceStreamSource<Chunk> = AsyncIterable<Chunk>
	| ((span: TraceSpanHandle) => AsyncIterable<Chunk> | Promise<AsyncIterable<Chunk>>);

export interface TraceSpanHandle {
	readonly context: TraceContext;
	setAttribute(name: string, value: unknown): void;
	setAttributes(attributes: unknown): void;
	addEvent(name: string, attributes?: unknown): void;
	setUsage(usage: SpanUsage): void;
	recordProviderUsage(provider: UsageProviderSelector, response: unknown, mapping?: TokenUsageMapping): void;
	captureInput(input: unknown): void;
	captureOutput(output: unknown): void;
}