import { CollectorLogSource } from 'model-worklog-sdk/rag';
import { LogQueryResponseSchema, LogSynthesisResultSchema, redactSensitiveText } from 'model-worklog-schema';

function detail(source) {
	const values = [];
	try { values.push(JSON.parse(source.excerpt)); } catch { /* SDK passages have a short header. */ }
	for (const match of source.excerpt.matchAll(/^(?:output|attributes|events): (.*)$/gm)) { try { values.push(JSON.parse(match[1])); } catch { /* Shortened JSON is evidence, not a complete object. */ } }
	for (const value of values) {
		const attributes = value?.attributes ?? value;
		const output = attributes?.output ?? attributes;
		const message = attributes?.['error.message'] ?? output?.summary ?? output?.message ?? (typeof output === 'string' ? output : undefined)
			?? (Array.isArray(value?.events) ? value.events : Array.isArray(value) ? value : []).find((event) => event.name === 'exception')?.attributes?.['exception.message'];
		if (typeof message === 'string' && message.trim() && !/[{}]/.test(message)) { return message.trim().slice(0, 500); }
	}
	return undefined;
}
function localAnswer(question, answer) {
	if (answer.totals.spans === 0) { return 'There are no captured logs in this scope yet. Record a sample or run a workspace review first.'; }
	if (answer.intent === 'tools') { return answer.answer; }
	if (/\b(amount|currency|total paid)\b/i.test(question) && !answer.evidence.some((source) => /"(?:amount|currency|totalPaid)"\s*:/.test(source.excerpt))) {
		return "The amount wasn't recorded in the retrieved logs, so I can't determine it.";
	}
	if (/\b(fail(?:ed|ure)?|error|wrong|rejected)\b/i.test(question)) {
		const failed = answer.evidence.filter((source) => source.state === 'failed' && detail(source));
		if (failed.length) { return failed.slice(0, 3).map((source) => `${source.name} failed: ${detail(source)} [${source.id}]`).join('\n\n'); }
	}
	if (/\b(answer|reply|summary|summarize|happened)\b/i.test(question)) {
		const source = answer.evidence.find((source) => ['agent', 'model'].includes(source.kind) && detail(source));
		if (source) { return `${detail(source)} [${source.id}]`; }
	}
	return 'I found related records, but they do not establish an answer to this question. You can inspect the captured sources below.';
}

/** The demo composes the SDK RAG port with collector-authorized exact counts. */
export function createSdkLogQuery({ client, rag, generator }) {
	const source = new CollectorLogSource(client);
	return async (request, cancellation) => {
		const signal = AbortSignal.any([AbortSignal.timeout(55_000), ...(cancellation ? [cancellation] : [])]); signal.throwIfAborted();
		const base = await client.askLogs({ ...request, synthesis: 'extractive' }, { signal });
		const originals = new Map();
		await rag.sync({ async load(scope, cancellation) {
			const snapshot = await source.load(scope, cancellation);
			for (const record of snapshot.spans) { originals.set(`${record.span.traceId}/${record.span.spanId}`, record); }
			return snapshot;
		} }, base.scope, { signal, prune: true });
		const result = await rag.search({ ...base.scope, question: request.question, history: request.history, mode: 'hybrid', limit: request.limit, signal });
		const evidence = result.hits.map((hit, index) => {
			const original = originals.get(`${hit.chunk.source.traceId}/${hit.chunk.source.spanId}`);
			return { ...hit.chunk.source, id: `S${index + 1}`, sequence: original?.sequence ?? index + 1, serviceName: original?.span.serviceName ?? 'indexed-log',
				excerpt: hit.chunk.text, excerptTruncated: hit.chunk.shortened };
		});
		// Tool names are filtering metadata, not part of the evidence wire schema.
		for (const item of evidence) { delete item.toolName; }
		const seen = new Set(evidence.map((item) => `${item.traceId}/${item.spanId}`));
		for (const item of base.evidence) {
			if (evidence.length >= Math.min(20, request.limit) || seen.has(`${item.traceId}/${item.spanId}`)) { continue; }
			evidence.push({ ...item, id: `S${evidence.length + 1}` }); seen.add(`${item.traceId}/${item.spanId}`);
		}
		const local = LogQueryResponseSchema.parse({ ...base, evidence, retrieval: { ...base.retrieval, strategy: `chroma-${result.mode}`, returnedSpans: evidence.length,
			contextExpanded: true, truncated: result.coverage.truncated || base.totals.spans > evidence.length,
			semantic: { mode: result.mode, indexedSpans: result.coverage.indexedSpans, indexedChunks: result.coverage.indexedChunks, partial: result.coverage.truncated, degraded: result.degraded } },
			limitations: [...new Set([...base.limitations, ...result.limitations])].slice(0, 14) });
		local.answer = localAnswer(request.question, local);
		if (request.synthesis !== 'model') { return local; }
		try {
			if (!generator) { throw new Error('No answer provider configured.'); }
			const generationSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
			const history = request.history.map((message) => ({ ...message, content: redactSensitiveText(message.content) }));
			let abort;
			let output;
			try {
				output = await Promise.race([generator.generate(redactSensitiveText(request.question), local, generationSignal, history), new Promise((_resolve, reject) => {
					abort = () => reject(generationSignal.reason); generationSignal.addEventListener('abort', abort, { once: true }); if (generationSignal.aborted) { abort(); }
				})]);
			} finally { if (abort) { generationSignal.removeEventListener('abort', abort); } }
			const generated = LogSynthesisResultSchema.parse(output);
			const available = new Set(['A1', ...evidence.map((item) => item.id)]); const cited = [...generated.answer.matchAll(/\[(S[1-9][0-9]*|A1)\]/g)].map((match) => match[1]);
			if ((!cited.length && base.totals.spans > 0) || cited.some((id) => !available.has(id) || !generated.sourceIds.includes(id)) || generated.sourceIds.some((id) => !available.has(id) || !cited.includes(id))) { throw new Error('Invalid answer citations.'); }
			return LogQueryResponseSchema.parse({ ...local, answer: redactSensitiveText(generated.answer), generation: { mode: 'model', status: 'generated', provider: generator.provider, model: generator.model } });
		} catch {
			signal.throwIfAborted();
			return LogQueryResponseSchema.parse({ ...local, generation: { mode: 'extractive', status: 'fallback' }, limitations: [...local.limitations, 'The answer provider was unavailable or returned invalid citations. The sources remain available.'] });
		}
	};
}
