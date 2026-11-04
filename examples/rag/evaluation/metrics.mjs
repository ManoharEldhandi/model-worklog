export function metrics(cases, ks = [1, 3, 5]) {
	const output = { queries: cases.length, mrrAt10: 0, ndcgAt5: 0 };
	for (const k of ks) { output[`precisionAt${k}`] = 0; output[`recallAt${k}`] = 0; }
	for (const item of cases) {
		const relevant = new Set(item.relevant); const retrieved = [...new Set(item.retrieved)];
		for (const k of ks) { const hits = retrieved.slice(0, k).filter((id) => relevant.has(id)).length; output[`precisionAt${k}`] += hits / k; output[`recallAt${k}`] += hits / relevant.size; }
		const first = retrieved.slice(0, 10).findIndex((id) => relevant.has(id)); if (first >= 0) { output.mrrAt10 += 1 / (first + 1); }
		const dcg = retrieved.slice(0, 5).reduce((sum, id, index) => sum + (relevant.has(id) ? 1 / Math.log2(index + 2) : 0), 0);
		const ideal = Array.from({ length: Math.min(5, relevant.size) }, (_, index) => 1 / Math.log2(index + 2)).reduce((sum, value) => sum + value, 0);
		output.ndcgAt5 += ideal === 0 ? 0 : dcg / ideal;
	}
	for (const key of Object.keys(output)) { if (key !== 'queries') { output[key] = cases.length === 0 ? 0 : output[key] / cases.length; } }
	return output;
}
