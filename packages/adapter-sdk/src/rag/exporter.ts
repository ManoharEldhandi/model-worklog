import { TraceBatchSchema, type TraceBatch, type TraceBatchAck, type StoredTraceSpan } from 'model-worklog-schema';
import { TraceExportError, type TraceExporter } from '../tracing/exporter';
import type { LogRag } from './engine';

/** Opt-in tracing sink. Normal SDK buffering/retry/failure-isolation still applies. */
export class LogRagTraceExporter implements TraceExporter {
	constructor(private readonly rag: Pick<LogRag, 'indexSpans'>, private readonly delegate?: TraceExporter) {}
	async export(input: TraceBatch, signal?: AbortSignal): Promise<TraceBatchAck> {
		const batch = TraceBatchSchema.parse(input);
		const receivedAt = new Date().toISOString();
		const records: StoredTraceSpan[] = batch.spans.map((span, index) => ({ span, receivedAt, sequence: index + 1, evidenceGrade: 'model-declared' }));
		try {
			const indexed = await this.rag.indexSpans(records, { signal });
			if (this.delegate !== undefined) { return await this.delegate.export(batch, signal); }
			return { schemaVersion: 1, accepted: indexed.indexedSpans, duplicates: batch.spans.length - indexed.indexedSpans };
		} catch (error) { if (error instanceof TraceExportError) { throw error; } throw new TraceExportError('network', true); }
	}
	async shutdown(): Promise<void> { await this.delegate?.shutdown?.(); }
}
