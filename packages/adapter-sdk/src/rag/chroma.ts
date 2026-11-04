import { ChromaClient, type Collection, type Metadata, type Where } from 'chromadb';
import { LogQueryEvidenceSchema } from 'model-worklog-schema';
import { validateRagScope } from './engine';
import type { LogRagChunk, LogRagScope, LogRagVectorStore } from './types';

export interface ChromaLogVectorStoreOptions {
	readonly url?: string; readonly collection: string; readonly tenant?: string; readonly database?: string; readonly headers?: Record<string, string>;
	readonly efSearch?: number; readonly efConstruction?: number; readonly maxNeighbors?: number;
}
function whereScope(input: LogRagScope, olderThanRevision?: number): Where {
	const scope = validateRagScope(input);
	const conditions: Where[] = [{ projectId: scope.projectId }];
	if (scope.traceId !== undefined) { conditions.push({ traceId: scope.traceId }); }
	if (scope.spanId !== undefined) { conditions.push({ spanId: scope.spanId }); }
	if (scope.toolName !== undefined) { conditions.push({ toolName: scope.toolName.toLowerCase() }); }
	if (scope.since !== undefined) { conditions.push({ startedMs: { $gte: Date.parse(scope.since) } }); }
	if (scope.until !== undefined) { conditions.push({ startedMs: { $lte: Date.parse(scope.until) } }); }
	if (olderThanRevision !== undefined) { conditions.push({ revision: { $lt: olderThanRevision } }); }
	return conditions.length === 1 ? conditions[0]! : { $and: conditions };
}
function decode(id: string, text: string | null | undefined, metadata: Metadata | null | undefined): LogRagChunk {
	if (typeof text !== 'string' || text.length > 1800 || metadata === null || metadata === undefined || typeof metadata.source !== 'string') { throw new Error('Invalid indexed log chunk.'); }
	const source = JSON.parse(metadata.source) as LogRagChunk['source'];
	const { toolName, ...sourceEvidence } = source;
	if (toolName !== undefined && (typeof toolName !== 'string' || toolName.length > 256)) { throw new Error('Invalid indexed tool name.'); }
	LogQueryEvidenceSchema.parse({ ...sourceEvidence, id: 'S1', sequence: 1, serviceName: 'log-rag', excerpt: text, excerptTruncated: metadata.shortened === true });
	if (![id, metadata.contentHash, metadata.spanHash].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))
		|| typeof metadata.chunkIndex !== 'number' || !Number.isInteger(metadata.chunkIndex) || metadata.chunkIndex < 0 || metadata.chunkIndex > 7
		|| typeof metadata.chunkCount !== 'number' || !Number.isInteger(metadata.chunkCount) || metadata.chunkCount < 1 || metadata.chunkCount > 8) { throw new Error('Invalid indexed chunk identity.'); }
	return { id, text, source, contentHash: metadata.contentHash as string, spanHash: metadata.spanHash as string, chunkIndex: metadata.chunkIndex, chunkCount: metadata.chunkCount, shortened: metadata.shortened === true };
}

/** Local/server Chroma with cosine HNSW. No default embedding function or cloud model. */
export class ChromaLogVectorStore implements LogRagVectorStore {
	readonly collectionName: string;
	private readonly url: URL;
	private embedding: { id: string; model: string } | undefined;
	constructor(private readonly options: ChromaLogVectorStoreOptions) {
		this.url = new URL(options.url ?? 'http://127.0.0.1:8000');
		if (this.url.username || this.url.password || this.url.search || this.url.hash || this.url.pathname !== '/'
			|| (this.url.protocol !== 'https:' && !(this.url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(this.url.hostname)))) { throw new Error('Chroma requires HTTPS or loopback HTTP without credentials, query, or path.'); }
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{1,510}[a-zA-Z0-9]$/.test(options.collection)) { throw new Error('Invalid Chroma collection name.'); }
		for (const [name, value, minimum, maximum] of [['efSearch', options.efSearch ?? 128, 1, 10000], ['efConstruction', options.efConstruction ?? 200, 1, 10000], ['maxNeighbors', options.maxNeighbors ?? 32, 2, 128]] as const) {
			if (!Number.isInteger(value) || value < minimum || value > maximum) { throw new Error(`Invalid ${name}.`); }
		}
		this.collectionName = options.collection;
	}
	private async collection(signal: AbortSignal, embedding = this.embedding): Promise<Collection> {
		signal.throwIfAborted(); if (embedding === undefined) { throw new Error('Initialize the vector store with an embedding model first.'); }
		const client = new ChromaClient({ host: this.url.hostname, port: this.url.port ? Number(this.url.port) : this.url.protocol === 'https:' ? 443 : 80, ssl: this.url.protocol === 'https:',
			tenant: this.options.tenant, database: this.options.database, headers: this.options.headers, fetchOptions: { signal, redirect: 'error', cache: 'no-store' } });
		const collection = await client.getOrCreateCollection({ name: this.collectionName, embeddingFunction: null,
			configuration: { hnsw: { space: 'cosine', ef_search: this.options.efSearch ?? 128, ef_construction: this.options.efConstruction ?? 200, max_neighbors: this.options.maxNeighbors ?? 32 } },
			metadata: { log_rag_schema: 1, log_rag_embedding: embedding.id, log_rag_model: embedding.model } });
		if (collection.metadata?.log_rag_schema !== 1 || collection.metadata.log_rag_embedding !== embedding.id) { throw new Error('Chroma collection uses a different embedding model or index schema. Use a new collection.'); }
		if (collection.configuration.hnsw?.space !== 'cosine') { throw new Error('The Chroma collection must use cosine HNSW.'); }
		return collection;
	}
	async initialize(embedding: { id: string; model: string }, signal: AbortSignal): Promise<void> { await this.collection(signal, embedding); this.embedding = { ...embedding }; }
	async describe(signal: AbortSignal): Promise<Collection['configuration']> { return (await this.collection(signal)).configuration; }
	async list(scope: LogRagScope, limit: number, signal: AbortSignal): Promise<{ chunks: readonly LogRagChunk[]; hasMore: boolean }> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100_000) { throw new Error('Invalid corpus limit.'); }
		const collection = await this.collection(signal); const where = whereScope(scope); const chunks: LogRagChunk[] = [];
		for (let offset = 0; chunks.length <= limit;) {
			signal.throwIfAborted(); const size = Math.min(256, limit + 1 - chunks.length);
			const page = await collection.get({ where, offset, limit: size, include: ['documents', 'metadatas'] });
			page.ids.forEach((id, index) => chunks.push(decode(id, page.documents[index], page.metadatas[index])));
			if (page.ids.length < size) { break; } offset += page.ids.length;
			if (chunks.length > limit) { break; }
		}
		return { chunks: chunks.slice(0, limit), hasMore: chunks.length > limit };
	}
	async upsert(chunks: readonly LogRagChunk[], vectors: readonly (readonly number[])[], signal: AbortSignal): Promise<void> {
		if (chunks.length === 0) { return; }
		if (chunks.length !== vectors.length || chunks.length > 1000) { throw new Error('Invalid vector batch.'); }
		const collection = await this.collection(signal);
		await collection.upsert({ ids: chunks.map((chunk) => chunk.id), documents: chunks.map((chunk) => chunk.text), embeddings: vectors.map((vector) => [...vector]),
			metadatas: chunks.map((chunk) => ({ projectId: chunk.source.projectId, traceId: chunk.source.traceId, spanId: chunk.source.spanId, revision: chunk.source.revision,
				startedMs: Date.parse(chunk.source.startedAt), toolName: chunk.source.toolName?.toLowerCase() ?? '',
				source: JSON.stringify(chunk.source), contentHash: chunk.contentHash, spanHash: chunk.spanHash, chunkIndex: chunk.chunkIndex, chunkCount: chunk.chunkCount, shortened: chunk.shortened })) });
	}
	async query(scope: LogRagScope, vector: readonly number[], limit: number, signal: AbortSignal): Promise<readonly { id: string; similarity: number }[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 1000) { throw new Error('Invalid vector candidate limit.'); }
		const collection = await this.collection(signal);
		const result = await collection.query({ queryEmbeddings: [[...vector]], nResults: limit, where: whereScope(scope), include: ['distances'] });
		return (result.ids[0] ?? []).map((id, index) => ({ id, similarity: Math.max(-1, Math.min(1, 1 - (result.distances?.[0]?.[index] ?? 2))) }));
	}
	async delete(scope: LogRagScope, signal: AbortSignal, olderThanRevision?: number): Promise<void> { const collection = await this.collection(signal); await collection.delete({ where: whereScope(scope, olderThanRevision) }); }
}
