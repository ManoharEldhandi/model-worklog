const stopWords = new Set('a an and are as at be by did do does for from had has have how i in is it its me of on or that the their this those to was were what when where which who why with you'.split(' '));

export function tokenize(text: string): string[] {
	const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_.:/-]*/gu) ?? [];
	return words.flatMap((word) => [word, ...(/[_.:/-]/.test(word) ? word.split(/[_.:/-]+/).filter((piece) => piece !== word) : [])]).filter((word) => word.length > 1 && !stopWords.has(word));
}
export interface RankedItem { readonly id: string; readonly score: number }

/** Robertson/Sparck Jones IDF, BM25 k1=1.2, b=.75; computed over the scoped corpus. */
export function bm25(question: string, documents: readonly { id: string; text: string }[]): RankedItem[] {
	const terms = [...new Set(tokenize(question))].slice(0, 64);
	if (documents.length === 0 || terms.length === 0) { return []; }
	const corpus = documents.map((document) => { const tokens = tokenize(document.text); const frequency = new Map<string, number>(); for (const token of tokens) { frequency.set(token, (frequency.get(token) ?? 0) + 1); } return { ...document, length: tokens.length, frequency }; });
	const average = corpus.reduce((sum, document) => sum + document.length, 0) / corpus.length || 1;
	const idf = new Map(terms.map((term) => { const n = corpus.filter((document) => document.frequency.has(term)).length; return [term, Math.log(1 + (corpus.length - n + .5) / (n + .5))]; }));
	return corpus.map((document) => ({ id: document.id, score: terms.reduce((score, term) => {
		const tf = document.frequency.get(term) ?? 0;
		return score + (idf.get(term) ?? 0) * tf * 2.2 / (tf + 1.2 * (.25 + .75 * document.length / average));
	}, 0) })).filter((document) => document.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

export function reciprocalRankFusion(lexical: readonly RankedItem[], vector: readonly RankedItem[], k = 60, weights: { lexical: number; vector: number } = { lexical: 1, vector: 1 }): RankedItem[] {
	if (!Number.isFinite(k) || k < 1) { throw new Error('rrfK must be positive.'); }
	if ([weights.lexical, weights.vector].some((value) => !Number.isFinite(value) || value < 0) || weights.lexical + weights.vector === 0) { throw new Error('Invalid RRF weights.'); }
	const scores = new Map<string, number>();
	for (const [list, weight] of [[lexical, weights.lexical], [vector, weights.vector]] as const) { const seen = new Set<string>(); list.forEach((item, rank) => { if (!seen.has(item.id)) { seen.add(item.id); scores.set(item.id, (scores.get(item.id) ?? 0) + weight / (k + rank + 1)); } }); }
	return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
