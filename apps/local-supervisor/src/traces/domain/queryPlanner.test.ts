import assert from 'node:assert/strict';
import test from 'node:test';

import { planLogQuery, queryTerms, requestedToolName } from './queryPlanner';

test('log query strategies distinguish exact analytics from evidence retrieval', () => {
	assert.equal(planLogQuery('What tools were used here?').intent, 'tools');
	assert.equal(planLogQuery('How many times was read_file used?').intent, 'tools');
	assert.equal(planLogQuery('How often was the MCP server invoked?').intent, 'tools');
	assert.equal(planLogQuery('Which tools failed and why?').intent, 'failures');
	assert.equal(planLogQuery('Find the inventory validation change').intent, 'search');
	assert.equal(planLogQuery('How many tokens were reported?').intent, 'search');
});

test('explicit tool names can be scoped even when the tool has never been captured', () => {
	assert.equal(requestedToolName('How many times was delete_file used?'), 'delete_file');
	assert.equal(requestedToolName('How often was the tool "mcp.lookup" invoked?'), 'mcp.lookup');
	assert.equal(requestedToolName('What tools were used?'), undefined);
	assert.equal(requestedToolName('How many times was this used?'), undefined);
});

test('retrieval terms are deterministic, bounded, Unicode-aware, and immutable', () => {
	assert.deepEqual(queryTerms('Please show the read_file read_file and inventory.ts'), ['read_file', 'inventory.ts']);
	assert.deepEqual(queryTerms('" OR * NOT (inventory) --'), ['not', 'inventory']);
	assert.deepEqual(queryTerms('The auth-token and cafe'), ['auth-token', 'cafe']);
	assert.equal(queryTerms(Array.from({ length: 100 }, (_, index) => `term${index}`).join(' ')).length, 12);
	assert.equal(queryTerms('x'.repeat(1000))[0]?.length, 80);
	assert.ok(Object.isFrozen(planLogQuery('tools')));
	assert.ok(Object.isFrozen(queryTerms('inventory')));
});

test('query planning accepts an independent ecosystem strategy without mutating it', () => {
	const strategy = Object.freeze({ intent: 'tools' as const, matches: (question: string): boolean => question.includes('operations') });
	assert.equal(planLogQuery('list operations', [strategy]).intent, 'tools');
	assert.equal(planLogQuery('find inventory', [strategy]).intent, 'search');
});
