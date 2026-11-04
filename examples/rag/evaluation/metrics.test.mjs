import assert from 'node:assert/strict';
import test from 'node:test';
import { metrics } from './metrics.mjs';

test('retrieval metrics use labelled source identities and standard precision/recall denominators', () => {
	const result = metrics([{ relevant: ['a'], retrieved: ['x', 'a', 'a', 'b'] }]);
	assert.equal(result.precisionAt1, 0); assert.equal(result.recallAt1, 0);
	assert.equal(result.precisionAt3, 1 / 3); assert.equal(result.recallAt3, 1);
	assert.equal(result.mrrAt10, .5); assert.equal(result.ndcgAt5, 1 / Math.log2(3));
	assert.equal(metrics([]).mrrAt10, 0);
});
