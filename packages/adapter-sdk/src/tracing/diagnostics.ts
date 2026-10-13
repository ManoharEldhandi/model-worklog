export interface TraceDiagnostic {
	readonly code: 'serialization_failed' | 'invalid_context' | 'usage_unavailable' | 'queue_full' | 'closed'
		| 'export_failed' | 'export_retry' | 'spool_failed' | 'replay_failed' | 'shutdown_failed' | 'active_limit';
	readonly count?: number;
	readonly attempt?: number;
	readonly retryable?: boolean;
	readonly statusCode?: number;
}

export type TraceDiagnosticHandler = (diagnostic: TraceDiagnostic) => void | Promise<void>;

export interface TraceFlushResult {
	readonly success: boolean;
	readonly accepted: number;
	readonly duplicates: number;
	readonly pending: number;
	readonly durablePending: number | null;
	readonly unpersisted: number;
	readonly dropped: number;
	readonly failed: number;
	readonly retries: number;
	readonly diagnosticFailures: number;
	readonly durability: 'memory' | 'spool';
	readonly lossRisk: boolean;
}

export class Diagnostics {
	failures = 0;

	constructor(private readonly handler?: TraceDiagnosticHandler) {}

	emit(diagnostic: TraceDiagnostic): void {
		try {
			if (this.handler === undefined) {
				if (diagnostic.code !== 'export_retry' && diagnostic.code !== 'usage_unavailable') {
					process.emitWarning(`Model Worklog telemetry: ${diagnostic.code}`, { code: 'MODEL_WORKLOG_TRACE' });
				}
				return;
			}
			void Promise.resolve(this.handler(Object.freeze({ ...diagnostic }))).catch(() => { this.failures += 1; });
		} catch { this.failures += 1; }
	}
}