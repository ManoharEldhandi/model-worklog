import { setTimeout as delay } from 'node:timers/promises';

import { TraceBatchAckSchema, type TraceBatchAck, type TraceSpan } from 'model-worklog-schema';

import { Diagnostics } from './diagnostics';
import { TraceExportError, type TraceExporter } from './exporter';
import { freeze, integerOption } from './privacy';

export interface DeliveryOptions {
	readonly maxRetries?: number;
	readonly retryDelayMs?: number;
	readonly exportTimeoutMs?: number;
}

async function deadline<Value>(operation: Promise<Value>, timeoutMs: number, abort: AbortController): Promise<Value> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => { abort.abort(); reject(new TraceExportError('timeout', false)); }, timeoutMs);
		})]);
	} finally { clearTimeout(timer); }
}

export class TraceDelivery {
	retries = 0;
	private busy = false;
	private readonly maxRetries: number;
	private readonly retryDelayMs: number;
	private readonly timeoutMs: number;

	constructor(private readonly exporter: TraceExporter, private readonly diagnostics: Diagnostics, options: DeliveryOptions) {
		if (typeof exporter.export !== 'function') { throw new Error('A TraceExporter is required.'); }
		this.maxRetries = integerOption(options.maxRetries, 2, 0, 10);
		this.retryDelayMs = integerOption(options.retryDelayMs, 50, 0, 30_000);
		this.timeoutMs = integerOption(options.exportTimeoutMs, 5_000, 1, 120_000);
	}

	async send(spans: TraceSpan[]): Promise<TraceBatchAck | undefined> {
		const batch = freeze({ schemaVersion: 1 as const, spans });
		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			try {
				if (this.busy) { throw new TraceExportError('timeout', false); }
				const abort = new AbortController();
				this.busy = true;
				const operation = Promise.resolve().then(() => this.exporter.export(batch, abort.signal));
				void operation.then(() => { this.busy = false; }, () => { this.busy = false; });
				const ack = TraceBatchAckSchema.parse(await deadline(operation, this.timeoutMs, abort));
				if (ack.accepted + ack.duplicates !== spans.length) { throw new TraceExportError('ack', false); }
				return ack;
			} catch (error) {
				const retryable = error instanceof TraceExportError && error.retryable;
				const statusCode = error instanceof TraceExportError ? error.statusCode : undefined;
				if (!retryable || attempt === this.maxRetries) {
					this.diagnostics.emit({ code: 'export_failed', count: spans.length, retryable, statusCode });
					return undefined;
				}
				this.retries += 1;
				this.diagnostics.emit({ code: 'export_retry', attempt: attempt + 1, count: spans.length, retryable, statusCode });
				await delay(Math.min(this.retryDelayMs * 2 ** attempt, 30_000));
			}
		}
		return undefined;
	}

	async shutdown(): Promise<boolean> {
		try {
			await deadline(Promise.resolve().then(() => this.exporter.shutdown?.()), this.timeoutMs, new AbortController());
			return true;
		} catch {
			this.diagnostics.emit({ code: 'shutdown_failed' });
			return false;
		}
	}
}