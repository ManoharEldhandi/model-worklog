import { LogQueryRequestSchema, LogQueryScopeSchema, SpanIdSchema, redactSensitiveText, type LogConversationMessage, type StoredTraceSpan } from 'model-worklog-schema';
import { chunkSpans, normalizeVector } from './chunking';
import { bm25, reciprocalRankFusion } from './ranking';
import type { LogRagAnswer, LogRagChunk, LogRagHit, LogRagOptions, LogRagScope, LogRagSearchRequest, LogRagSearchResult, LogRagSource } from './types';

const sourceKey = (chunk: LogRagChunk): string => JSON.stringify([chunk.source.projectId, chunk.source.traceId, chunk.source.spanId]);
export function validateRagScope(input: LogRagScope): LogRagScope {
	const { projectId, traceId, toolName, since, until, spanId } = input;
	const scope = LogQueryScopeSchema.parse({ projectId, traceId, toolName, since, until });
	if (since !== undefined && until !== undefined && Date.parse(since) > Date.parse(until)) { throw new Error('since must not follow until.'); }
	return { ...scope, ...(spanId === undefined ? {} : { spanId: SpanIdSchema.parse(spanId) }) };
}
export function chunkInScope(chunk: LogRagChunk, scope: LogRagScope): boolean {
	return chunk.source.projectId === scope.projectId && (scope.traceId === undefined || chunk.source.traceId === scope.traceId)
		&& (scope.spanId === undefined || chunk.source.spanId === scope.spanId)
		&& (scope.toolName === undefined || chunk.source.toolName?.toLowerCase() === scope.toolName.toLowerCase())
		&& (scope.since === undefined || Date.parse(chunk.source.startedAt) >= Date.parse(scope.since))
		&& (scope.until === undefined || Date.parse(chunk.source.startedAt) <= Date.parse(scope.until));
}
async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted(); let abort: (() => void) | undefined;
	try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) { abort(); } })]); }
	finally { if (abort !== undefined) { signal.removeEventListener('abort', abort); } }
}
function deadline(signal: AbortSignal | undefined, milliseconds: number): AbortSignal { return AbortSignal.any([AbortSignal.timeout(milliseconds), ...(signal === undefined ? [] : [signal])]); }
function integer(value: number, minimum: number, maximum: number, name: string): number { if (!Number.isInteger(value) || value < minimum || value > maximum) { throw new Error(`${name} must be ${minimum}–${maximum}.`); } return value; }

/** SDK-owned hybrid RAG. The application owns authentication and index lifecycle. */
export class LogRag {
	private initialized: Promise<void> | undefined;
	private writing: Promise<unknown> = Promise.resolve();
	private readonly candidates: number;
	private readonly maxCorpus: number;
	private readonly rrfK: number;
	private readonly minimum: number;
	constructor(private readonly options: LogRagOptions) {
		this.candidates = integer(options.candidates ?? 100, 1, 1000, 'candidates');
		this.maxCorpus = integer(options.maxCorpusChunks ?? 20_000, 1, 100_000, 'maxCorpusChunks');
		this.rrfK = integer(options.rrfK ?? 60, 1, 1000, 'rrfK');
		this.minimum = options.minSimilarity ?? .25;
		if (!Number.isFinite(this.minimum) || this.minimum < -1 || this.minimum > 1) { throw new Error('minSimilarity must be between -1 and 1.'); }
		if (options.lexicalWeight !== undefined && (!Number.isFinite(options.lexicalWeight) || options.lexicalWeight < 0 || options.lexicalWeight > 1)) { throw new Error('lexicalWeight must be between 0 and 1.'); }
		if (options.minRerankScore !== undefined && (!Number.isFinite(options.minRerankScore) || options.minRerankScore < 0 || options.minRerankScore > 1)) { throw new Error('minRerankScore must be between 0 and 1.'); }
		if (options.rerankVectorWeight !== undefined && (!Number.isFinite(options.rerankVectorWeight) || options.rerankVectorWeight < 0 || options.rerankVectorWeight > 1)) { throw new Error('rerankVectorWeight must be between 0 and 1.'); }
		if (options.rerankRecallFloor !== undefined && (!Number.isFinite(options.rerankRecallFloor) || options.rerankRecallFloor < -1 || options.rerankRecallFloor > 1)) { throw new Error('Invalid rerankRecallFloor.'); }
		if (options.failureBoost !== undefined && (!Number.isFinite(options.failureBoost) || options.failureBoost < 0 || options.failureBoost > 1)) { throw new Error('Invalid failureBoost.'); }
	}
	private ready(signal: AbortSignal): Promise<void> {
		this.initialized ??= bounded(this.options.store.initialize({ id: this.options.embedder.id, model: this.options.embedder.model }, signal), signal).catch((error: unknown) => { this.initialized = undefined; throw error; });
		return bounded(this.initialized, signal);
	}
	private write<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
		const task = this.writing.catch(() => undefined).then(() => { signal.throwIfAborted(); return operation(); });
		this.writing = task; return bounded(task, signal);
	}
	indexSpans(spans: readonly StoredTraceSpan[], options: { signal?: AbortSignal } = {}): Promise<{ indexedSpans: number; skippedSpans: number }> {
		const signal = deadline(options.signal, 120_000);
		if (spans.length > 1000) { return Promise.reject(new Error('Index at most 1000 spans per batch.')); }
		return this.write(() => this.indexBatch(spans, signal), signal);
	}
	private async indexBatch(spans: readonly StoredTraceSpan[], signal: AbortSignal): Promise<{ indexedSpans: number; skippedSpans: number }> {
		await this.ready(signal);
		const grouped = new Map<string, LogRagChunk[]>();
		for (const chunk of chunkSpans(spans)) { const key = sourceKey(chunk); const prior = grouped.get(key); if (prior === undefined || prior[0]!.source.revision < chunk.source.revision) { grouped.set(key, [chunk]); } else if (prior[0]!.source.revision === chunk.source.revision) { if (prior[0]!.spanHash !== chunk.spanHash) { throw new Error('Conflicting span revision.'); } if (!prior.some((item) => item.id === chunk.id)) { prior.push(chunk); } } }
		let indexedSpans = 0; let skippedSpans = 0;
		const cache = new Map<string, readonly number[]>();
		for (const chunks of grouped.values()) {
			signal.throwIfAborted(); const first = chunks[0]!;
			const scope = { projectId: first.source.projectId, traceId: first.source.traceId, spanId: first.source.spanId };
			const existing = await bounded(this.options.store.list(scope, 1000, signal), signal);
			if (existing.hasMore) { throw new Error('The span index needs reconciliation before revision updates.'); }
			const latest = Math.max(0, ...existing.chunks.map((chunk) => chunk.source.revision));
			if (latest > first.source.revision) { skippedSpans += 1; continue; }
			if (latest === first.source.revision) {
				const current = existing.chunks.filter((chunk) => chunk.source.revision === latest);
				if (current.some((chunk) => chunk.spanHash !== first.spanHash)) { throw new Error('Conflicting span revision.'); }
				if (current.length === chunks.length && chunks.every((chunk) => current.some((item) => item.id === chunk.id))) { skippedSpans += 1; continue; }
			}
			const missing = [...new Map(chunks.filter((chunk) => !cache.has(chunk.contentHash)).map((chunk) => [chunk.contentHash, chunk])).values()];
			for (let offset = 0; offset < missing.length; offset += 16) {
				const batch = missing.slice(offset, offset + 16);
				const vectors = await bounded(this.options.embedder.embed(batch.map((chunk) => chunk.text), signal), signal);
				if (vectors.length !== batch.length) { throw new Error('Embedding count mismatch.'); }
				batch.forEach((chunk, index) => cache.set(chunk.contentHash, normalizeVector(vectors[index]!)));
			}
			const vectors = chunks.map((chunk) => cache.get(chunk.contentHash)!);
			if (vectors.some((vector) => vector.length !== vectors[0]!.length)) { throw new Error('Embedding dimensions changed within a span.'); }
			await bounded(this.options.store.upsert(chunks, vectors, signal), signal);
			await bounded(this.options.store.delete(scope, signal, first.source.revision), signal);
			indexedSpans += 1;
		}
		return { indexedSpans, skippedSpans };
	}
	delete(scope: LogRagScope, options: { signal?: AbortSignal } = {}): Promise<void> {
		const selected = validateRagScope(scope); const signal = deadline(options.signal, 30_000);
		return this.write(async () => { await this.ready(signal); await bounded(this.options.store.delete(selected, signal), signal); }, signal);
	}
	async sync(source: LogRagSource, scope: LogRagScope, options: { signal?: AbortSignal; prune?: boolean } = {}): Promise<{ indexedSpans: number; complete: boolean; limitations: readonly string[] }> {
		const selected = validateRagScope(scope); const signal = deadline(options.signal, 120_000);
		return this.write(async () => {
			await this.ready(signal);
			const snapshot = await bounded(source.load(selected, signal), signal);
			const chunks = chunkSpans(snapshot.spans);
			if (chunks.some((chunk) => !chunkInScope(chunk, selected))) { throw new Error('The log source returned spans outside the requested scope.'); }
			let indexedSpans = 0;
			for (let offset = 0; offset < snapshot.spans.length; offset += 1000) { indexedSpans += (await this.indexBatch(snapshot.spans.slice(offset, offset + 1000), signal)).indexedSpans; }
			if (options.prune === true) {
				if (!snapshot.complete) { throw new Error('Cannot prune from an incomplete source snapshot.'); }
				const previous = await bounded(this.options.store.list(selected, this.maxCorpus, signal), signal);
				if (previous.hasMore) { throw new Error('Cannot prune an incomplete index scan. Narrow the scope.'); }
				const retained = new Set(chunks.map(sourceKey)); const removed = new Set<string>();
				for (const chunk of previous.chunks) { const key = sourceKey(chunk); if (!retained.has(key) && !removed.has(key)) { removed.add(key); await bounded(this.options.store.delete({ projectId: chunk.source.projectId, traceId: chunk.source.traceId, spanId: chunk.source.spanId }, signal), signal); } }
			}
			return { indexedSpans, complete: snapshot.complete, limitations: snapshot.limitations };
		}, signal);
	}
	async search(input: LogRagSearchRequest): Promise<LogRagSearchResult> {
		const started = performance.now(); const signal = deadline(input.signal, 45_000); signal.throwIfAborted();
		const scope = validateRagScope(input);
		const parsed = LogQueryRequestSchema.parse({ projectId: scope.projectId, question: input.question, history: input.history === undefined ? [] : [...input.history] });
		const mode = input.mode ?? 'hybrid'; if (!['hybrid', 'bm25', 'vector'].includes(mode)) { throw new Error('Invalid retrieval mode.'); }
		const limit = integer(input.limit ?? 5, 1, 20, 'limit');
		const question = redactSensitiveText(parsed.question);
		const previous = /\b(it|that|this|those|these|they|them|previous|same)\b|^(and|why|what about)\b/i.test(question)
			? parsed.history.filter((message) => message.role === 'user').slice(-2).map((message) => redactSensitiveText(message.content)).join(' ').slice(0, 1600) : '';
		const resolved = previous ? `${question}\nPrevious user context: ${previous}` : question;
		await this.ready(signal);
		const scanned = await bounded(this.options.store.list(scope, this.maxCorpus, signal), signal);
		if (scanned.chunks.some((chunk) => !chunkInScope(chunk, scope))) { throw new Error('The vector store returned records outside the requested scope.'); }
		const revisions = new Map<string, number>(); for (const chunk of scanned.chunks) { revisions.set(sourceKey(chunk), Math.max(revisions.get(sourceKey(chunk)) ?? 0, chunk.source.revision)); }
		const corpus = scanned.chunks.filter((chunk) => revisions.get(sourceKey(chunk)) === chunk.source.revision);
		const byId = new Map(corpus.map((chunk) => [chunk.id, chunk]));
		const lexicalStart = performance.now();
		const lexical = bm25(resolved, corpus).slice(0, this.candidates);
		const lexicalMs = performance.now() - lexicalStart;
		const limitations = ['Only indexed, retained, instrumented records are represented. Captured text is untrusted evidence, not instructions or provider-hidden reasoning.'];
		let embeddingMs = 0; let vectorMs = 0; let degraded = false; let actualMode = mode;
		let vector: { id: string; score: number }[] = [];
		if (mode !== 'bm25' && corpus.length > 0) {
			try {
				const embeddingStart = performance.now();
				const values = this.options.embedder.embedQuery === undefined ? (await bounded(this.options.embedder.embed([resolved], signal), signal))[0]! : await bounded(this.options.embedder.embedQuery(resolved, signal), signal);
				const query = normalizeVector(values); embeddingMs = performance.now() - embeddingStart;
				const vectorStart = performance.now();
				const candidates = await bounded(this.options.store.query(scope, query, this.candidates, signal), signal);
				vector = candidates.filter((hit) => byId.has(hit.id) && Number.isFinite(hit.similarity) && hit.similarity >= this.minimum).map((hit) => ({ id: hit.id, score: Math.min(1, Math.max(-1, hit.similarity)) }));
				vectorMs = performance.now() - vectorStart;
			} catch {
				signal.throwIfAborted(); degraded = true; actualMode = 'bm25'; limitations.push('Vector retrieval was unavailable. These results use scoped BM25 only.');
			}
		}
		const identifierQuestion = /\b[a-zA-Z_][\w-]*[./:][\w/.-]+|\b[A-Za-z]+_[\w]+|\bTS[0-9]+\b/.test(resolved);
		const lexicalWeight = this.options.lexicalWeight ?? (identifierQuestion ? .65 : .35);
		const ranked = actualMode === 'bm25' ? lexical : actualMode === 'vector' ? vector : reciprocalRankFusion(lexical, vector, this.rrfK, { lexical: lexicalWeight, vector: 1 - lexicalWeight });
		const lexicalRanks = new Map(lexical.map((item, index) => [item.id, { rank: index + 1, score: item.score }]));
		const vectorRanks = new Map(vector.map((item, index) => [item.id, { rank: index + 1, score: item.score }]));
		const seenContent = new Set<string>(); const perSpan = new Map<string, number>();
		let hits: LogRagHit[] = [];
		for (const item of ranked) {
			const chunk = byId.get(item.id); if (chunk === undefined || seenContent.has(chunk.contentHash) || (perSpan.get(sourceKey(chunk)) ?? 0) >= 2) { continue; }
			seenContent.add(chunk.contentHash); perSpan.set(sourceKey(chunk), (perSpan.get(sourceKey(chunk)) ?? 0) + 1);
			const lexicalRank = lexicalRanks.get(item.id); const vectorRank = vectorRanks.get(item.id);
			hits.push({ id: `S${hits.length + 1}`, chunk, score: item.score, ...(lexicalRank === undefined ? {} : { bm25: lexicalRank.score }), ...(vectorRank === undefined ? {} : { similarity: vectorRank.score }), ranks: { lexical: lexicalRank?.rank, vector: vectorRank?.rank } });
			if (hits.length >= (this.options.reranker === undefined ? Math.max(limit * 3, limit) : Math.min(60, this.candidates))) { break; }
		}
		if (this.options.reranker !== undefined && hits.length > 0) {
			try {
				const order = await bounded(this.options.reranker.rerank(question, hits, signal), signal);
				const ids = order.map((item) => typeof item === 'string' ? item : item.id);
				if (ids.length !== hits.length || new Set(ids).size !== ids.length || ids.some((id) => !hits.some((hit) => hit.id === id))) { throw new Error('Invalid reranker source IDs.'); }
				hits = order.map((item) => {
					if (typeof item === 'string') { return hits.find((hit) => hit.id === item)!; }
					if (!Number.isFinite(item.score)) { throw new Error('Invalid reranker score.'); }
					const hit = hits.find((hit) => hit.id === item.id)!;
					const weight = hit.similarity === undefined ? 0 : this.options.rerankVectorWeight ?? .75;
					const failureQuestion = /\b(fail(?:ed|ure|ures)?|errors?|exceptions?|rejected|denied|starved|unhealthy|deadlock)\b|\bno longer\b|\b(?:could|did|was|were)\b.*\bnot\b/i.test(question);
					const failureBoost = failureQuestion && hit.chunk.source.state === 'failed' ? this.options.failureBoost ?? .1 : 0;
					return { ...hit, relevance: item.score, score: (1 - weight) * item.score + weight * (hit.similarity ?? 0) + failureBoost };
				}).filter((hit) => hit.relevance === undefined || this.options.minRerankScore === undefined || hit.relevance >= this.options.minRerankScore
					|| (this.options.rerankRecallFloor !== undefined && hit.similarity !== undefined && hit.similarity >= this.options.rerankRecallFloor));
				if (order.every((item) => typeof item !== 'string')) { hits.sort((a, b) => b.score - a.score); }
			} catch { signal.throwIfAborted(); degraded = true; limitations.push('The reranker was unavailable or invalid; the original retrieval order is retained.'); }
		}
		hits = hits.slice(0, limit).map((hit, index) => ({ ...hit, id: `S${index + 1}` }));
		const sources = [...new Map(corpus.map((chunk) => [sourceKey(chunk), chunk.source])).values()];
		if (scanned.hasMore) { limitations.push('The scoped corpus exceeds maxCorpusChunks. Retrieval and aggregates are partial; narrow the scope or raise the configured limit.'); }
		const shortenedSpans = new Set(corpus.filter((chunk) => chunk.shortened).map(sourceKey)).size;
		if (shortenedSpans > 0) { limitations.push(`${shortenedSpans} indexed spans have shortened content. Full semantic recall is not guaranteed.`); }
		return { question, scope, mode: actualMode, degraded, snapshotAt: new Date().toISOString(), hits,
			aggregates: { spans: sources.length, toolCalls: sources.filter((source) => source.kind === 'tool').length, failedSpans: sources.filter((source) => source.state === 'failed').length, complete: !scanned.hasMore },
			coverage: { indexedSpans: sources.length, indexedChunks: corpus.length, truncated: scanned.hasMore, shortenedSpans }, limitations,
			timings: { totalMs: performance.now() - started, embeddingMs, vectorMs, lexicalMs } };
	}
	async ask(input: LogRagSearchRequest): Promise<LogRagAnswer> {
		const signal = deadline(input.signal, 60_000); const result = await this.search({ ...input, signal });
		const extractive = result.hits.length === 0 ? 'No relevant indexed evidence was retrieved for this scope. Missing capture or index coverage cannot be reconstructed.'
			: result.hits.map((hit) => `[${hit.id}] ${hit.chunk.source.name} (${hit.chunk.source.kind}, ${hit.chunk.source.state})\n${hit.chunk.text}`).join('\n\n').slice(0, 16000);
		if (this.options.answerer === undefined) { return { ...result, answer: extractive, generation: 'extractive' }; }
		try {
			const history = LogQueryRequestSchema.parse({ projectId: result.scope.projectId, question: result.question, history: [...(input.history ?? [])] }).history.map((message) => ({ ...message, content: redactSensitiveText(message.content).replace(/\[(?:S[1-9][0-9]*|A1)\]/g, '(previous citation)') }));
			const generated = await bounded(this.options.answerer.answer(result.question, result, history, signal), signal);
			if (typeof generated.answer !== 'string' || !generated.answer.trim() || generated.answer.length > 16000 || !Array.isArray(generated.sourceIds)) { throw new Error('Invalid generated answer.'); }
			const available = new Set(['A1', ...result.hits.map((hit) => hit.id)]);
			const cited = [...generated.answer.matchAll(/\[(S[1-9][0-9]*|A1)\]/g)].map((match) => match[1]!);
			if ((result.hits.length > 0 && cited.length === 0) || cited.some((id) => !available.has(id) || !generated.sourceIds.includes(id)) || generated.sourceIds.some((id) => !available.has(id) || !cited.includes(id))) { throw new Error('Invalid answer citations.'); }
			return { ...result, answer: redactSensitiveText(generated.answer), generation: 'generated' };
		} catch { signal.throwIfAborted(); return { ...result, answer: extractive, generation: 'fallback', limitations: [...result.limitations, 'The answer provider failed or returned invalid citations. This is an extractive evidence fallback.'] }; }
	}
}
