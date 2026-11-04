import type { CaptureReport, LogConversationMessage, LogQueryScope, SpanKind, SpanUsage, StoredTraceSpan } from 'model-worklog-schema';

export interface LogRagScope extends LogQueryScope { readonly spanId?: string }
export interface LogRagSourceReference {
	readonly projectId: string; readonly traceId: string; readonly spanId: string; readonly revision: number;
	readonly name: string; readonly kind: SpanKind; readonly state: StoredTraceSpan['span']['state']; readonly startedAt: string;
	readonly capture: CaptureReport; readonly evidenceGrade: 'model-declared'; readonly usage?: SpanUsage;
	readonly toolName?: string;
}
export interface LogRagChunk {
	readonly id: string; readonly text: string; readonly contentHash: string; readonly spanHash: string;
	readonly chunkIndex: number; readonly chunkCount: number; readonly shortened: boolean;
	readonly source: LogRagSourceReference;
}
export interface LogRagEmbedder {
	/** Stable model/version/prefix identity. Changing it requires a new collection. */
	readonly id: string; readonly model: string;
	embed(texts: readonly string[], signal: AbortSignal): Promise<readonly (readonly number[])[]>;
	embedQuery?(question: string, signal: AbortSignal): Promise<readonly number[]>;
}
export interface LogRagVectorStore {
	initialize(embedding: { id: string; model: string }, signal: AbortSignal): Promise<void>;
	list(scope: LogRagScope, limit: number, signal: AbortSignal): Promise<{ chunks: readonly LogRagChunk[]; hasMore: boolean }>;
	upsert(chunks: readonly LogRagChunk[], vectors: readonly (readonly number[])[], signal: AbortSignal): Promise<void>;
	query(scope: LogRagScope, vector: readonly number[], limit: number, signal: AbortSignal): Promise<readonly { id: string; similarity: number }[]>;
	delete(scope: LogRagScope, signal: AbortSignal, olderThanRevision?: number): Promise<void>;
}
export interface LogRagHit {
	readonly id: string; readonly chunk: LogRagChunk; readonly score: number;
	readonly bm25?: number; readonly similarity?: number; readonly ranks: { readonly lexical?: number; readonly vector?: number };
	readonly relevance?: number;
}
export interface LogRagSearchRequest extends LogRagScope {
	readonly question: string; readonly mode?: 'hybrid' | 'bm25' | 'vector'; readonly limit?: number;
	readonly history?: readonly LogConversationMessage[]; readonly signal?: AbortSignal;
}
export interface LogRagSearchResult {
	readonly question: string; readonly scope: LogRagScope; readonly hits: readonly LogRagHit[];
	readonly mode: 'hybrid' | 'bm25' | 'vector'; readonly snapshotAt: string;
	readonly degraded: boolean;
	readonly aggregates: { readonly spans: number; readonly toolCalls: number; readonly failedSpans: number; readonly complete: boolean };
	readonly coverage: { readonly indexedSpans: number; readonly indexedChunks: number; readonly truncated: boolean; readonly shortenedSpans: number };
	readonly limitations: readonly string[]; readonly timings: { readonly totalMs: number; readonly embeddingMs: number; readonly vectorMs: number; readonly lexicalMs: number };
}
export interface LogRagReranker {
	rerank(question: string, hits: readonly LogRagHit[], signal: AbortSignal): Promise<readonly string[] | readonly { id: string; score: number }[]>;
}
export interface LogRagAnswerer {
	answer(question: string, result: LogRagSearchResult, history: readonly LogConversationMessage[], signal: AbortSignal): Promise<{ answer: string; sourceIds: readonly string[] }>;
}
export interface LogRagAnswer extends LogRagSearchResult { readonly answer: string; readonly generation: 'extractive' | 'generated' | 'fallback' }
export interface LogRagSource {
	load(scope: LogRagScope, signal: AbortSignal): Promise<{ spans: readonly StoredTraceSpan[]; complete: boolean; limitations: readonly string[] }>;
}
export interface LogRagOptions {
	readonly store: LogRagVectorStore; readonly embedder: LogRagEmbedder; readonly answerer?: LogRagAnswerer; readonly reranker?: LogRagReranker;
	readonly candidates?: number; readonly rrfK?: number; readonly maxCorpusChunks?: number; readonly minSimilarity?: number;
	readonly lexicalWeight?: number;
	readonly minRerankScore?: number;
	readonly rerankVectorWeight?: number;
	readonly rerankRecallFloor?: number;
	readonly failureBoost?: number;
}
