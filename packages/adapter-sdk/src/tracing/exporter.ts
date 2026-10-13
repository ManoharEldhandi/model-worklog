import type { TraceBatch, TraceBatchAck } from 'model-worklog-schema';

export interface TraceExporter {
	export(batch: TraceBatch, signal?: AbortSignal): Promise<TraceBatchAck>;
	shutdown?(): Promise<void>;
}

export class TraceExportError extends Error {
	constructor(
		readonly code: 'network' | 'http' | 'ack' | 'timeout' | 'payload',
		readonly retryable: boolean,
		readonly statusCode?: number,
	) {
		super(`Trace export failed (${code}).`);
		this.name = 'TraceExportError';
	}
}