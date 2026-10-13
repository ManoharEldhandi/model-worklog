import { ExportResultCode, type ExportResult } from '@opentelemetry/core';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';

import { loggerPipeline, type ModelLogger } from './logger';
import { otelSnapshots } from './otelMapping';

export class ModelLoggerSpanExporter implements SpanExporter {
	private readonly pending = new Set<Promise<void>>();
	private closing?: Promise<void>;

	constructor(private readonly logger: ModelLogger) {}

	export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
		if (this.closing !== undefined) { this.reply(resultCallback, false); return; }
		if (spans.length === 0) { this.reply(resultCallback, true); return; }
		const pipeline = this.logger[loggerPipeline];
		let queued = true;
		for (const span of spans) {
			try {
				for (const snapshot of otelSnapshots(span, this.logger, pipeline.settings)) {
					queued = pipeline.enqueue(snapshot) && queued;
				}
			} catch { pipeline.reject('serialization_failed'); queued = false; }
		}
		if (!queued) { this.reply(resultCallback, false); return; }
		const task = this.logger.flush().then(
			(result) => { this.reply(resultCallback, queued && result.success); },
			() => { this.reply(resultCallback, false); },
		);
		this.pending.add(task);
		void task.then(() => { this.pending.delete(task); });
	}

	async forceFlush(): Promise<void> {
		if (this.closing !== undefined) { return this.closing; }
		await Promise.all([...this.pending]);
		if (!(await this.logger.flush()).success) { throw new Error('Trace flush incomplete; inspect logger diagnostics and status.'); }
	}

	shutdown(): Promise<void> {
		if (this.closing !== undefined) { return this.closing; }
		this.closing = (async () => {
			await Promise.all([...this.pending]);
			if (!(await this.logger.shutdown()).success) { throw new Error('Trace shutdown incomplete; pending or lost snapshots remain.'); }
		})();
		return this.closing;
	}

	private reply(callback: (result: ExportResult) => void, success: boolean): void {
		try {
			void Promise.resolve(callback(success ? { code: ExportResultCode.SUCCESS } : {
				code: ExportResultCode.FAILED, error: new Error('Trace export incomplete.'),
			})).catch(() => { this.logger[loggerPipeline].diagnostics.emit({ code: 'serialization_failed' }); });
		} catch { this.logger[loggerPipeline].diagnostics.emit({ code: 'serialization_failed' }); }
	}
}