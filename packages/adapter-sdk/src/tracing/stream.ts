import type { ModelSpan } from './span';
import type { TraceStreamOptions, TraceStreamSource } from './types';

interface StreamLifecycle {
	start(): ModelSpan;
	run<Result>(span: ModelSpan, operation: () => Result): Result;
	finish(span: ModelSpan): void;
	readonly contentEnabled: boolean;
	onTelemetryError(): void;
}

export async function* traceStream<Chunk>(
	options: TraceStreamOptions<Chunk>, source: TraceStreamSource<Chunk>, lifecycle: StreamLifecycle,
): AsyncGenerator<Chunk, unknown, unknown> {
	const span = lifecycle.start();
	let iterator: AsyncIterator<Chunk, unknown, unknown> | undefined;
	let state: 'completed' | 'failed' | 'interrupted' = 'interrupted';
	let primaryFailure = false;
	try {
		iterator = await lifecycle.run(span, async () => {
			const iterable = typeof source === 'function' ? await source(span) : source;
			return iterable[Symbol.asyncIterator]();
		});
		const activeIterator = iterator;
		let input: unknown;
		while (true) {
			const next = await lifecycle.run(span, () => activeIterator.next(input));
			if (next.done) { state = 'completed'; return next.value; }
			try {
				await lifecycle.run(span, async () => {
					await options.onChunk?.(next.value, span);
					if (lifecycle.contentEnabled && options.serializeChunk !== undefined) {
						span.addEvent('stream.chunk', { content: options.serializeChunk(next.value) });
					}
				});
			} catch { lifecycle.onTelemetryError(); }
			input = yield next.value;
		}
	} catch (error) {
		state = 'failed';
		primaryFailure = true;
		throw error;
	} finally {
		try {
			if (state !== 'completed' && iterator?.return !== undefined) {
				const closing = iterator;
				await lifecycle.run(span, () => closing.return?.());
			}
		} catch (error) {
			if (!primaryFailure) { state = 'failed'; throw error; }
		} finally {
			span.end(state);
			lifecycle.finish(span);
		}
	}
}