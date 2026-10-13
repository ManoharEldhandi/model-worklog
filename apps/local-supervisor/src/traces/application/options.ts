import type { TraceStorageLimits, TraceStorageOptions } from '../domain/contracts';

function bounded(value: number, minimum: number, maximum: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) { throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`); }
	return value;
}

export function traceStorageLimits(options: TraceStorageOptions = {}): TraceStorageLimits {
	return {
		maxStoredSpans: bounded(options.maxStoredSpans ?? 100_000, 1, 100_000, 'maxStoredSpans'),
		maxStoredBytes: bounded(options.maxStoredBytes ?? 128 * 1024 * 1024, 1_024, 256 * 1024 * 1024, 'maxStoredBytes'),
		maxSpansPerTrace: bounded(options.maxSpansPerTrace ?? 2_000, 1, 10_000, 'maxSpansPerTrace'),
		...(options.retentionTtlSeconds === undefined ? {} : { retentionTtlSeconds: bounded(options.retentionTtlSeconds, 60, 31_536_000, 'retentionTtlSeconds') }),
	};
}