import type { TraceSpan } from 'model-worklog-schema';

export interface TraceSpoolEntry {
	readonly id: string;
	readonly span: TraceSpan;
}

export interface TraceSpool {
	prepare?(span: TraceSpan): TraceSpan;
	append(span: TraceSpan): Promise<string>;
	read(limit: number): Promise<readonly TraceSpoolEntry[]>;
	remove(id: string): Promise<void>;
	count(): Promise<number>;
}