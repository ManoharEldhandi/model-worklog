import type { PrivacyOptions, TraceSpan } from 'model-worklog-schema';

import { Diagnostics, type TraceDiagnosticHandler, type TraceFlushResult } from './diagnostics';
import { TraceDelivery, type DeliveryOptions } from './delivery';
import type { TraceExporter } from './exporter';
import { captureSettings, integerOption, prepareSnapshot, type CaptureSettings, type TraceLimits } from './privacy';
import type { TraceSpool, TraceSpoolEntry } from './spool';

export interface TraceProcessorOptions extends DeliveryOptions {
	readonly exporter: TraceExporter;
	readonly privacy?: PrivacyOptions;
	readonly limits?: TraceLimits;
	readonly spool?: TraceSpool;
	readonly maxQueueSize?: number;
	readonly maxBatchSize?: number;
	readonly maxBatchBytes?: number;
	readonly flushIntervalMs?: number;
	readonly onDiagnostic?: TraceDiagnosticHandler;
}

interface PendingSpan {
	readonly span: TraceSpan;
	readonly sequence: number;
	readonly bytes: number;
	id?: string;
	persistence?: Promise<void>;
}

export class TraceProcessor {
	readonly settings: CaptureSettings;
	readonly diagnostics: Diagnostics;
	private readonly delivery: TraceDelivery;
	private readonly queue: PendingSpan[] = [];
	private readonly maxQueueSize: number;
	private readonly maxBatchSize: number;
	private readonly maxBatchBytes: number;
	private readonly spool?: TraceSpool;
	private readonly timer?: ReturnType<typeof setInterval>;
	private serial: Promise<unknown> = Promise.resolve();
	private closing?: Promise<TraceFlushResult>;
	private closed = false;
	private autoBlocked = false;
	private scheduled = false;
	private flushes = 0;
	private sequence = 0;
	private accepted = 0;
	private duplicates = 0;
	private dropped = 0;
	private failed = 0;

	constructor(options: TraceProcessorOptions) {
		this.settings = captureSettings(options.privacy, options.limits);
		this.diagnostics = new Diagnostics(options.onDiagnostic);
		this.delivery = new TraceDelivery(options.exporter, this.diagnostics, options);
		this.spool = options.spool;
		this.maxQueueSize = integerOption(options.maxQueueSize, 1_024, 1, 100_000);
		this.maxBatchSize = integerOption(options.maxBatchSize, Math.min(32, this.maxQueueSize), 1, Math.min(100, this.maxQueueSize));
		this.maxBatchBytes = integerOption(options.maxBatchBytes, Math.max(1_048_576, this.settings.maxSpanBytes + 32), this.settings.maxSpanBytes + 32, 8_388_608);
		const interval = integerOption(options.flushIntervalMs, 1_000, 0, 120_000);
		if (interval > 0) { this.timer = setInterval(() => this.schedule(), interval); this.timer.unref(); }
	}

	reject(code: 'serialization_failed' | 'active_limit' | 'closed'): void {
		this.dropped += 1;
		this.diagnostics.emit({ code, count: 1 });
	}

	enqueue(input: TraceSpan): boolean {
		if (this.closed || this.queue.length >= this.maxQueueSize) {
			this.dropped += 1;
			this.diagnostics.emit({ code: this.closed ? 'closed' : 'queue_full', count: 1 });
			return false;
		}
		try {
			const prepared = prepareSnapshot(input, this.settings);
			const span = this.spool?.prepare === undefined ? prepared : prepareSnapshot(this.spool.prepare(prepared), this.settings);
			const entry: PendingSpan = { span, sequence: ++this.sequence, bytes: Buffer.byteLength(JSON.stringify(span)) };
			this.queue.push(entry);
			if (this.spool !== undefined) { void this.persist(entry); }
			if (this.queue.length >= this.maxBatchSize) { this.schedule(); }
			return true;
		} catch { this.reject('serialization_failed'); return false; }
	}

	flush(): Promise<TraceFlushResult> {
		if (this.closing !== undefined) { return this.closing.then((result) => this.result(result.success)); }
		const through = this.sequence;
		this.flushes += 1;
		const result = this.serial.then(async () => {
			let success = false;
			try { success = await this.drain(through); }
			catch { this.diagnostics.emit({ code: 'replay_failed' }); }
			this.autoBlocked = !success;
			return this.result(success);
		}).finally(() => { this.flushes -= 1; });
		this.serial = result;
		return result;
	}

	shutdown(): Promise<TraceFlushResult> {
		if (this.closing !== undefined) { return this.closing; }
		this.closed = true;
		clearInterval(this.timer);
		this.closing = this.flush().then(async (result) => {
			const closed = await this.delivery.shutdown();
			return Object.freeze({ ...result, success: result.success && closed });
		});
		return this.closing;
	}

	private schedule(): void {
		if (this.closed || this.autoBlocked || this.scheduled || this.flushes > 0) { return; }
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (!this.closed && !this.autoBlocked && this.flushes === 0) { void this.flush(); }
		});
	}

	private persist(entry: PendingSpan): Promise<void> {
		if (entry.id !== undefined || this.spool === undefined) { return Promise.resolve(); }
		if (entry.persistence !== undefined) { return entry.persistence; }
		entry.persistence = Promise.resolve().then(() => this.spool?.append(entry.span)).then((id) => { entry.id = id; }).catch(() => {
			this.diagnostics.emit({ code: 'spool_failed', count: 1 });
		}).finally(() => { entry.persistence = undefined; });
		return entry.persistence;
	}

	private pack(entries: readonly PendingSpan[]): PendingSpan[] {
		let bytes = 32;
		const batch: PendingSpan[] = [];
		for (const entry of entries) {
			if (batch.length >= this.maxBatchSize || (batch.length > 0 && bytes + entry.bytes + 1 > this.maxBatchBytes)) { break; }
			bytes += entry.bytes + 1;
			batch.push(entry);
		}
		return batch;
	}

	private async deliver(entries: readonly PendingSpan[]): Promise<boolean> {
		const ack = await this.delivery.send(entries.map((entry) => entry.span));
		if (ack === undefined) { this.failed += entries.length; return false; }
		this.accepted += ack.accepted;
		this.duplicates += ack.duplicates;
		try {
			for (const entry of entries) { if (entry.id !== undefined) { await this.spool?.remove(entry.id); } }
			return true;
		} catch { this.diagnostics.emit({ code: 'spool_failed', count: entries.length }); return false; }
	}

	private async drain(through: number): Promise<boolean> {
		while (this.queue[0] !== undefined && this.queue[0].sequence <= through) {
			const entries = this.pack(this.queue.filter((entry) => entry.sequence <= through));
			if (this.spool !== undefined) {
				await Promise.all(entries.map((entry) => this.persist(entry)));
				if (entries.some((entry) => entry.id === undefined)) { return false; }
			}
			if (!await this.deliver(entries)) { return false; }
			this.queue.splice(0, entries.length);
		}
		if (this.spool !== undefined && this.queue.length === 0) {
			let remaining = await this.spool.count();
			while (remaining > 0 && this.queue.length === 0) {
				const stored = await this.spool.read(Math.min(remaining, this.maxBatchSize));
				if (stored.length === 0) { return false; }
				const entries = this.pack(stored.map((entry: TraceSpoolEntry) => {
					const span = prepareSnapshot(entry.span, this.settings);
					return { id: entry.id, span, sequence: 0, bytes: Buffer.byteLength(JSON.stringify(span)) };
				}));
				if (!await this.deliver(entries)) { return false; }
				remaining -= entries.length;
			}
		}
		return true;
	}

	private async result(complete: boolean): Promise<TraceFlushResult> {
		let durablePending: number | null = 0;
		try { durablePending = await this.spool?.count() ?? 0; }
		catch { durablePending = null; this.diagnostics.emit({ code: 'spool_failed' }); }
		const unpersisted = this.queue.filter((entry) => entry.id === undefined).length;
		const pending = Math.max(this.queue.length, (durablePending ?? 0) + unpersisted);
		return Object.freeze({
			success: complete && pending === 0 && durablePending !== null && this.dropped === 0,
			accepted: this.accepted, duplicates: this.duplicates, pending, durablePending, unpersisted,
			dropped: this.dropped, failed: this.failed, retries: this.delivery.retries, diagnosticFailures: this.diagnostics.failures,
			durability: this.spool === undefined ? 'memory' : 'spool', lossRisk: unpersisted > 0 || this.dropped > 0 || durablePending === null,
		});
	}
}