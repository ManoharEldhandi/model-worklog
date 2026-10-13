import * as assert from 'assert';
import { exportTrace } from '../traceExport';
import { buildSpanForest, presentSpan, presentTrace, traceWarnings } from '../tracePresentation';
import { publicStoredSpan, traceText } from '../tracePrivacy';
import { jsonResponse, mockTraceApi, storedSpan, traceId, traceSummary } from './traceFixtures';

suite('Trace presentation and export', () => {
	test('shows unknown usage for a final span without inventing zero or derived totals', () => {
		const span = storedSpan();
		const node = buildSpanForest([span]).nodes[0];
		assert.ok(node);
		const presented = presentSpan(node);
		assert.match(presented.summary, /tokens: not reported/);
		assert.strictEqual(presented.fields.find((field) => field.label === 'totalTokens')?.value, 'unknown (not reported)');
		const partial = buildSpanForest([storedSpan({ usage: { source: 'provider-reported', inputTokens: 4, outputTokens: 6 } })]).nodes[0];
		assert.ok(partial);
		assert.match(presentSpan(partial).summary, /tokens: not reported/);
		assert.match(presentTrace(traceSummary()).description, /tokens: not reported/);
		assert.match(presentTrace(traceSummary({ totalTokens: 0 })).description, /tokens: 0/);
	});

	test('nests out-of-order spans by stable IDs and exposes dangling parents and cycles', () => {
		const parent = storedSpan();
		const child = storedSpan({ spanId: '2'.repeat(16), parentSpanId: parent.span.spanId });
		const dangling = storedSpan({ spanId: '3'.repeat(16), parentSpanId: '4'.repeat(16) });
		const forest = buildSpanForest([child, dangling, parent]);
		assert.strictEqual(forest.nodes.find((node) => node.id === child.span.spanId)?.parentId, parent.span.spanId);
		assert.strictEqual(forest.nodes.find((node) => node.id === dangling.span.spanId)?.parentId, undefined);
		assert.deepStrictEqual(forest.missingParents, ['4'.repeat(16)]);
		assert.match(traceWarnings(forest).join('\n'), /missing/);
		assert.deepStrictEqual(forest.nodes.map((node) => node.id), buildSpanForest([parent, child, dangling]).nodes.map((node) => node.id));
		const cycle = buildSpanForest([storedSpan({ parentSpanId: child.span.spanId }), child]);
		assert.strictEqual(cycle.cycles.length, 2);
		assert.ok(cycle.nodes.every((node) => node.parentId === undefined));
	});

	test('uses the final revision as-is even when an earlier running revision had usage', () => {
		const running = storedSpan({ revision: 1, state: 'running', endedAt: undefined, usage: { source: 'adapter-reported', totalTokens: 10 } });
		const final = storedSpan();
		assert.strictEqual(buildSpanForest([final, running]).nodes[0]?.stored.span.usage, undefined);
	});

	test('redacts credential-bearing URLs, secret attributes and hidden reasoning before presentation', () => {
		assert.strictEqual(traceText('https://user:password@example.com/private'), '[REDACTED URL]');
		assert.strictEqual(traceText('https://example.com/?access_token=private'), '[REDACTED URL]');
		const publicSpan = publicStoredSpan(storedSpan({ attributes: { password: 'private', thinking: 'hidden', endpoint: 'https://user:pass@example.com', text: 'Bearer private-token' } }));
		const serialized = JSON.stringify(publicSpan);
		assert.ok(!serialized.includes('private'));
		assert.ok(!serialized.includes('hidden'));
		assert.ok(!serialized.includes('user:pass'));
		assert.strictEqual(publicSpan.span.usage, undefined);
	});

	test('exports all validated pages with scope and missing-parent/gap warnings, but no connection secrets', async () => {
		const first = storedSpan({ parentSpanId: '9'.repeat(16), capture: { mode: 'metadata', redactedFields: 0, truncatedFields: 1, droppedEvents: 2, limitations: ['Delivery was bounded.'] } });
		const second = storedSpan({ spanId: '2'.repeat(16) });
		const cursors: (string | null)[] = [];
		const api = mockTraceApi(async (url) => {
			cursors.push(url.searchParams.get('cursor'));
			assert.strictEqual(url.searchParams.get('limit'), '100');
			return jsonResponse({ schemaVersion: 1, spans: [url.searchParams.has('cursor') ? second : first], nextCursor: url.searchParams.has('cursor') ? null : 'next' });
		});
		const exported = await exportTrace(api, 'app', traceId, new AbortController().signal, traceSummary({ spanCount: 3, incomplete: true }));
		assert.deepStrictEqual(cursors, [null, 'next']);
		assert.strictEqual(exported.spans.length, 2);
		assert.strictEqual(exported.metadata.allAvailablePagesCollected, true);
		assert.strictEqual(exported.metadata.underlyingExecutionComplete, false);
		assert.deepStrictEqual(exported.metadata.missingParentSpanIds, ['9'.repeat(16)]);
		assert.match(exported.metadata.warnings.join('\n'), /Span count gap/);
		assert.match(exported.metadata.warnings.join('\n'), /droppedEvents: 2/);
		assert.ok(!JSON.stringify(exported).includes('isolated-test-token'));
		assert.ok(!JSON.stringify(exported).includes('127.0.0.1'));
	});

	test('does not export a schema-valid span from a different project or trace', async () => {
		for (const span of [storedSpan({ projectId: 'other' }), storedSpan({ traceId: '2'.repeat(32) })]) {
			const api = mockTraceApi(async () => jsonResponse({ schemaVersion: 1, spans: [span], nextCursor: null }));
			await assert.rejects(exportTrace(api, 'app', traceId, new AbortController().signal), /outside the requested/);
		}
	});
});