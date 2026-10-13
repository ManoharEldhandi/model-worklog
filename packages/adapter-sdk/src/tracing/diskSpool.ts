import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { TraceSpanSchema, type PrivacyOptions, type TraceSpan } from 'model-worklog-schema';

import { captureSettings, integerOption, prepareSnapshot, type CaptureSettings, type TraceLimits } from './privacy';
import type { TraceSpool, TraceSpoolEntry } from './spool';
import { atomicWrite, privateDirectory, privateFile, readBounded, spoolFilename, spoolFiles, syncDirectory } from './spoolFiles';

export interface DiskTraceSpoolOptions {
	readonly directory: string;
	readonly privacy?: PrivacyOptions;
	readonly limits?: TraceLimits;
	readonly maxFiles?: number;
	readonly maxBytes?: number;
}

export class DiskTraceSpool implements TraceSpool {
	private tail: Promise<void> = Promise.resolve();
	private readonly settings: CaptureSettings;
	private readonly maxFiles: number;
	private readonly maxBytes: number;

	private constructor(private readonly directory: string, private readonly device: number, private readonly inode: number, options: DiskTraceSpoolOptions) {
		this.settings = captureSettings(options.privacy, options.limits);
		this.maxFiles = integerOption(options.maxFiles, 10_000, 1, 1_000_000);
		this.maxBytes = integerOption(options.maxBytes, 67_108_864, 2_048, Number.MAX_SAFE_INTEGER);
	}

	static async open(options: DiskTraceSpoolOptions): Promise<DiskTraceSpool> {
		const directory = resolve(options.directory);
		const metadata = await privateDirectory(directory, true);
		const spool = new DiskTraceSpool(directory, metadata.dev, metadata.ino, options);
		await spool.count();
		return spool;
	}

	prepare(input: TraceSpan): TraceSpan { return prepareSnapshot(input, this.settings); }

	async append(input: TraceSpan): Promise<string> {
		const span = this.prepare(input);
		const content = JSON.stringify(span);
		return this.serialize(async () => {
			const inventory = await this.inventory();
			if (inventory.entries >= this.maxFiles || inventory.bytes + Buffer.byteLength(content) > this.maxBytes) {
				throw new Error('Trace spool is full.');
			}
			const id = `${randomUUID()}.json`;
			await atomicWrite(this.directory, id, content);
			return id;
		});
	}

	read(limit: number): Promise<readonly TraceSpoolEntry[]> {
		const bounded = integerOption(limit, 100, 1, 100);
		return this.serialize(async () => {
			await this.checkDirectory();
			const entries: TraceSpoolEntry[] = [];
			for await (const entry of spoolFiles(this.directory)) {
				if (entry.temporary) { continue; }
				const input = TraceSpanSchema.parse(JSON.parse(await readBounded(join(this.directory, entry.name), this.settings.maxSpanBytes)) as unknown);
				entries.push(Object.freeze({ id: entry.name, span: prepareSnapshot(input, this.settings) }));
				if (entries.length >= bounded) { break; }
			}
			return Object.freeze(entries);
		});
	}

	remove(id: string): Promise<void> {
		if (!spoolFilename.test(id)) { return Promise.reject(new Error('Invalid spool identifier.')); }
		return this.serialize(async () => {
			await this.checkDirectory();
			const path = join(this.directory, id);
			try { const handle = await privateFile(path, this.settings.maxSpanBytes); await handle.close(); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
			await unlink(path);
			await syncDirectory(this.directory);
		});
	}

	count(): Promise<number> { return this.serialize(async () => (await this.inventory()).committed); }

	private serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
		const result = this.tail.then(operation);
		this.tail = result.then(() => undefined, () => undefined);
		return result;
	}

	private async checkDirectory(): Promise<void> {
		const metadata = await privateDirectory(this.directory);
		if (metadata.dev !== this.device || metadata.ino !== this.inode) { throw new Error('Spool directory was replaced.'); }
	}

	private async inventory(): Promise<{ committed: number; entries: number; bytes: number }> {
		await this.checkDirectory();
		let committed = 0;
		let entries = 0;
		let bytes = 0;
		for await (const entry of spoolFiles(this.directory)) {
			const handle = await privateFile(join(this.directory, entry.name), this.settings.maxSpanBytes);
			try { bytes += (await handle.stat()).size; } finally { await handle.close(); }
			entries += 1;
			if (!entry.temporary) { committed += 1; }
		}
		return { committed, entries, bytes };
	}
}