export class TraceRequests {
	private cancellation = new AbortController();
	private tail: Promise<void> = Promise.resolve();
	private readonly jobs = new Map<string | symbol, Promise<unknown>>();
	private pending = 0;
	revision = 0;

	get busy(): boolean { return this.pending > 0; }

	reset(): void {
		this.cancellation.abort();
		this.cancellation = new AbortController();
		this.revision += 1;
		this.jobs.clear();
	}

	run<Value>(key: string | symbol, action: (signal: AbortSignal) => Promise<Value>): Promise<Value> {
		const existing = this.jobs.get(key);
		if (existing !== undefined) { return existing as Promise<Value>; }
		const signal = this.cancellation.signal;
		this.pending += 1;
		const queued = this.tail.then(async () => {
			signal.throwIfAborted();
			const result = await action(signal);
			signal.throwIfAborted();
			return result;
		});
		const task = queued.finally(() => {
			this.pending -= 1;
			if (this.jobs.get(key) === task) { this.jobs.delete(key); }
		});
		this.jobs.set(key, task);
		this.tail = task.then(() => undefined, () => undefined);
		return task;
	}

	async idle(): Promise<void> { await this.tail; }
}