import { AsyncLocalStorage } from 'node:async_hooks';

import { ProjectIdSchema } from 'model-worklog-schema';

import { newContext, validateContext, type TraceContext } from './context';
import type { TraceFlushResult } from './diagnostics';
import { integerOption, label } from './privacy';
import { TraceProcessor } from './processor';
import { ModelSpan } from './span';
import { traceStream } from './stream';
import type { ModelLoggerOptions, SpanOptions, TraceOptions, TraceSpanHandle, TraceStreamOptions, TraceStreamSource } from './types';

export const loggerPipeline = Symbol('model-worklog.trace-pipeline');

export class ModelLogger {
	readonly projectId: string;
	readonly serviceName: string;
	readonly [loggerPipeline]: TraceProcessor;
	private readonly storage = new AsyncLocalStorage<TraceContext>();
	private readonly active = new Set<ModelSpan>();
	private readonly maxActiveSpans: number;
	private closed = false;

	constructor(options: ModelLoggerOptions) {
		this.projectId = ProjectIdSchema.parse(options.projectId);
		if (typeof options.serviceName !== 'string' || options.serviceName.trim() === '' || options.serviceName.length > 128) {
			throw new Error('serviceName must contain 1 to 128 characters.');
		}
		this.serviceName = label(options.serviceName, 128, 'service');
		this.maxActiveSpans = integerOption(options.maxActiveSpans, 1_024, 1, 100_000);
		this[loggerPipeline] = new TraceProcessor(options);
	}

	currentContext(): TraceContext | undefined { return this.storage.getStore(); }

	async trace<Result>(options: TraceOptions<Result>, operation: (span: TraceSpanHandle) => Result | Promise<Result>): Promise<Result> {
		const span = this.start(options, this.currentContext());
		return this.storage.run(span.context, async () => {
			try {
				const result = await operation(span);
				span.guard(() => {
					if (options.serializeResult !== undefined && this[loggerPipeline].settings.policy.mode === 'redacted-content') {
						span.captureOutput(options.serializeResult(result));
					}
				});
				span.end('completed');
				return result;
			} catch (error) {
				span.end('failed');
				throw error;
			} finally { this.active.delete(span); }
		});
	}

	wrap<This, Arguments extends unknown[], Result>(
		options: TraceOptions<Result>, operation: (this: This, ...args: Arguments) => Result | Promise<Result>,
	): (this: This, ...args: Arguments) => Promise<Result> {
		const logger = this;
		return function (this: This, ...args: Arguments): Promise<Result> {
			return logger.trace(options, () => operation.apply(this, args));
		};
	}

	stream<Chunk>(options: TraceStreamOptions<Chunk>, source: TraceStreamSource<Chunk>): AsyncGenerator<Chunk, unknown, unknown> {
		const inherited = this.currentContext();
		return traceStream(options, source, {
			start: () => this.start(options, inherited),
			run: (span, operation) => this.storage.run(span.context, operation),
			finish: (span) => { this.active.delete(span); },
			contentEnabled: this[loggerPipeline].settings.policy.mode === 'redacted-content',
			onTelemetryError: () => { this[loggerPipeline].diagnostics.emit({ code: 'serialization_failed', count: 1 }); },
		});
	}

	flush(): Promise<TraceFlushResult> { return this[loggerPipeline].flush(); }

	shutdown(): Promise<TraceFlushResult> {
		this.closed = true;
		for (const span of this.active) { span.end('interrupted'); }
		this.active.clear();
		return this[loggerPipeline].shutdown();
	}

	private start(options: SpanOptions, inherited: TraceContext | undefined): ModelSpan {
		const processor = this[loggerPipeline];
		let parent: TraceContext | undefined;
		try {
			const requested = options.parent;
			const selected = requested === null ? undefined : requested ?? inherited;
			parent = selected === undefined ? undefined : validateContext(selected);
		}
		catch { processor.diagnostics.emit({ code: 'invalid_context' }); }
		const context = newContext(parent);
		const enabled = !this.closed && this.active.size < this.maxActiveSpans;
		if (!enabled) { processor.reject(this.closed ? 'closed' : 'active_limit'); }
		let span: ModelSpan;
		try { span = new ModelSpan(context, parent, this, processor, options, enabled); }
		catch {
			processor.reject('serialization_failed');
			span = new ModelSpan(context, parent, this, processor, { name: 'unrecorded' }, false);
		}
		if (enabled) { this.active.add(span); }
		return span;
	}
}

export function createModelLogger(options: ModelLoggerOptions): ModelLogger { return new ModelLogger(options); }