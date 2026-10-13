import { TraceBatchAckSchema, TraceBatchSchema, type TraceBatch, type TraceBatchAck } from 'model-worklog-schema';

import { TraceExportError, type TraceExporter } from './exporter';

export const DEFAULT_TRACE_ENDPOINT = 'http://127.0.0.1:43199/v2/traces/batch';

export interface HttpTraceExporterOptions {
	readonly token: string;
	readonly endpoint?: string;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof globalThis.fetch;
}

function traceEndpoint(raw: string): URL {
	const endpoint = new URL(raw);
	if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
		|| endpoint.username !== '' || endpoint.password !== '' || raw.includes('@')
		|| raw.includes('?') || raw.includes('#') || !['/', '/v2/traces/batch'].includes(endpoint.pathname)) {
		throw new Error('Trace endpoint must be loopback HTTP without credentials, query, or fragment.');
	}
	endpoint.pathname = '/v2/traces/batch';
	return endpoint;
}

async function acknowledgement(response: Response): Promise<TraceBatchAck> {
	const reader = response.body?.getReader();
	if (reader === undefined) { throw new TraceExportError('ack', false); }
	const buffers: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) { break; }
			bytes += next.value.byteLength;
			if (bytes > 16_384) { throw new TraceExportError('ack', false); }
			buffers.push(next.value);
		}
		return TraceBatchAckSchema.parse(JSON.parse(Buffer.concat(buffers).toString('utf8')) as unknown);
	} catch {
		throw new TraceExportError('ack', false);
	} finally {
		await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
}

export class HttpTraceExporter implements TraceExporter {
	private readonly endpoint: URL;
	private readonly token: string;
	private readonly timeoutMs: number;
	private readonly fetchImpl: typeof globalThis.fetch;

	constructor(options: HttpTraceExporterOptions) {
		this.endpoint = traceEndpoint(options.endpoint ?? DEFAULT_TRACE_ENDPOINT);
		this.token = options.token.trim();
		if (this.token === '' || this.token.length > 4_096 || /[\s\x00-\x1f\x7f]/.test(this.token)) {
			throw new Error('A nonempty trace writer token is required.');
		}
		this.timeoutMs = options.timeoutMs ?? 5_000;
		if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000) {
			throw new Error('timeoutMs must be an integer between 1 and 120000.');
		}
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
	}

	async export(batch: TraceBatch, signal?: AbortSignal): Promise<TraceBatchAck> {
		const body = JSON.stringify(TraceBatchSchema.parse(batch));
		if (Buffer.byteLength(body) > 8_388_608) { throw new TraceExportError('payload', false); }
		let response: Response;
		try {
			response = await this.fetchImpl(new URL(this.endpoint), {
				method: 'POST', redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal === undefined ? [] : [signal])]),
				headers: { 'content-type': 'application/json', 'x-model-worklog-token': this.token }, body,
			});
		} catch {
			throw new TraceExportError('network', true);
		}
		if (!response.ok || response.redirected) {
			await response.body?.cancel().catch(() => undefined);
			throw new TraceExportError('http', !response.redirected && (response.status === 408 || response.status === 429 || response.status >= 500), response.status);
		}
		const ack = await acknowledgement(response);
		if (ack.accepted + ack.duplicates !== batch.spans.length) { throw new TraceExportError('ack', false); }
		return ack;
	}
}