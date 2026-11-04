import type { LogRagEmbedder } from './types';
import { hash, normalizeVector } from './chunking';

export interface OpenAiLogEmbeddingOptions {
	readonly endpoint: string; readonly model: string; readonly apiKey?: string;
	readonly queryPrefix?: string; readonly documentPrefix?: string;
}
export class OpenAiLogEmbedder implements LogRagEmbedder {
	readonly id: string; readonly model: string;
	private readonly endpoint: string;
	private active = 0;
	constructor(private readonly options: OpenAiLogEmbeddingOptions) {
		const endpoint = new URL(options.endpoint);
		if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) { throw new Error('Embeddings require HTTPS or loopback HTTP without URL credentials, query, or fragment.'); }
		if (!options.model.trim() || options.model.length > 128 || /[\r\n]/.test(options.apiKey ?? '') || (options.queryPrefix?.length ?? 0) > 200 || (options.documentPrefix?.length ?? 0) > 200) { throw new Error('Invalid embedding configuration.'); }
		this.model = options.model; this.endpoint = endpoint.href;
		this.id = hash(JSON.stringify([this.endpoint, this.model, options.queryPrefix, options.documentPrefix, 'log-chunks-v1']));
	}
	async embedQuery(question: string, signal: AbortSignal): Promise<readonly number[]> { return (await this.request([(this.options.queryPrefix ?? '') + question], signal))[0]!; }
	async embed(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]> { return this.request(texts.map((text) => (this.options.documentPrefix ?? '') + text), signal); }
	private async request(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]> {
		if (texts.length < 1 || texts.length > 16 || texts.some((text) => !text || text.length > 4000) || this.active >= 2) { throw new Error('Embedding input exceeds limits or provider is busy.'); }
		signal.throwIfAborted(); this.active += 1;
		try {
			const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
				headers: { 'content-type': 'application/json', ...(this.options.apiKey === undefined ? {} : { authorization: `Bearer ${this.options.apiKey}` }) }, body: JSON.stringify({ model: this.model, input: texts, encoding_format: 'float' }) });
			if (!response.ok) { await response.body?.cancel(); throw new Error('Embedding provider failed.'); }
			const reader = response.body?.getReader(); if (reader === undefined) { throw new Error('Empty embedding response.'); }
			let payload: unknown;
			try {
				const chunks: Uint8Array[] = []; let bytes = 0;
				for (;;) { const next = await reader.read(); if (next.done) { break; } bytes += next.value.byteLength; if (bytes > 2 * 1024 * 1024) { throw new Error('Embedding response too large.'); } chunks.push(next.value); }
				payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
			} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
			const data = (payload as { data?: unknown } | null)?.data;
			if (!Array.isArray(data) || data.length !== texts.length) { throw new Error('Invalid embedding count.'); }
			const vectors: number[][] = []; const seen = new Set<number>();
			for (const item of data as { index?: unknown; embedding?: unknown }[]) {
				if (!Number.isInteger(item?.index) || (item.index as number) < 0 || (item.index as number) >= texts.length || seen.has(item.index as number) || !Array.isArray(item.embedding)) { throw new Error('Invalid embedding indexes.'); }
				seen.add(item.index as number); vectors[item.index as number] = normalizeVector(item.embedding as number[]);
			}
			if (vectors.some((vector) => vector.length !== vectors[0]!.length)) { throw new Error('Inconsistent embedding dimensions.'); }
			return vectors;
		} finally { this.active -= 1; }
	}
}
