import type { LogRagHit, LogRagReranker } from './types';

/** Adapter for the example's local /v1/rerank service; custom rerankers can use the port directly. */
export class HttpLogRagReranker implements LogRagReranker {
	private readonly endpoint: string;
	constructor(endpoint: string, private readonly model = 'ms-marco-MiniLM-L-12-v2') {
		const url = new URL(endpoint);
		if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) { throw new Error('Reranking requires HTTPS or loopback HTTP without URL credentials.'); }
		this.endpoint = url.href;
	}
	async rerank(question: string, hits: readonly LogRagHit[], signal: AbortSignal): Promise<readonly { id: string; score: number }[]> {
		if (question.length > 4000 || hits.length > 60) { throw new Error('Reranking input exceeds limits.'); }
		const response = await fetch(this.endpoint, { method: 'POST', redirect: 'error', cache: 'no-store', signal,
			headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: this.model, query: question, documents: hits.map((hit) => ({ id: hit.id, text: hit.chunk.text })) }) });
		if (!response.ok) { await response.body?.cancel(); throw new Error('Reranking provider failed.'); }
		const reader = response.body?.getReader(); if (reader === undefined) { throw new Error('Empty reranking response.'); }
		try {
			const chunks: Uint8Array[] = []; let size = 0;
			for (;;) { const next = await reader.read(); if (next.done) { break; } size += next.value.byteLength; if (size > 128 * 1024) { throw new Error('Reranking response exceeds limits.'); } chunks.push(next.value); }
			const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as { results?: { id?: unknown; score?: unknown }[] };
			if (!Array.isArray(payload.results) || payload.results.length !== hits.length || payload.results.some((item) => typeof item.id !== 'string' || typeof item.score !== 'number' || !Number.isFinite(item.score))) { throw new Error('Invalid reranking response.'); }
			const ids = payload.results.map((item) => item.id as string);
			if (new Set(ids).size !== hits.length || ids.some((id) => !hits.some((hit) => hit.id === id))) { throw new Error('Invalid reranking source identities.'); }
			return payload.results.map((item) => ({ id: item.id as string, score: item.score as number }));
		} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
	}
}
