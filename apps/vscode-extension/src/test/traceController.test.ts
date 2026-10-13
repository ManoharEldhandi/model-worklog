import * as assert from 'assert';
import { TraceController, type TraceSchedule } from '../traceController';
import { collectTracePages } from '../tracePages';
import { deferred, jsonResponse, mockTraceApi, storedSpan, traceId, traceSummary } from './traceFixtures';

suite('Trace controller lifecycle', () => {
	test('a startup connection finishing after disable cannot re-enable traces', async () => {
		const controller = new TraceController('app');
		const attempt = controller.beginConnection();
		controller.disable();
		await controller.enable(mockTraceApi(async () => { throw new Error('No requests after disable'); }), attempt);
		controller.connectionFailed(attempt);
		assert.strictEqual(controller.state.enabled, false);
		assert.strictEqual(controller.state.phase, 'disabled');
		controller.dispose();
	});

	test('switching selection aborts the earlier detail and preserves the newer selection', async () => {
		const started = deferred<AbortSignal>();
		const release = deferred<Response>();
		const secondId = '2'.repeat(32);
		const controller = new TraceController('app');
		await controller.enable(mockTraceApi(async (url, init) => {
			if (url.pathname === '/v2/traces') { return jsonResponse({ schemaVersion: 1, traces: [traceSummary(), traceSummary({ traceId: secondId })], nextCursor: null }); }
			if (url.pathname.endsWith(traceId)) { assert.ok(init.signal); started.resolve(init.signal); return release.promise; }
			return jsonResponse({ schemaVersion: 1, spans: [storedSpan({ traceId: secondId })], nextCursor: null });
		}));
		const first = controller.select(traceId);
		const signal = await started.promise;
		const second = controller.select(secondId);
		assert.strictEqual(signal.aborted, true);
		release.resolve(jsonResponse({ schemaVersion: 1, spans: [storedSpan()], nextCursor: null }));
		await Promise.all([first, second]);
		assert.strictEqual(controller.state.selectedTraceId, secondId);
		assert.strictEqual(controller.state.spans[0]?.span.traceId, secondId);
		controller.dispose();
	});

	test('project change aborts old work, serializes requests and cannot publish stale results', async () => {
		const started = deferred<AbortSignal>();
		const release = deferred<Response>();
		let active = 0;
		let peak = 0;
		const api = mockTraceApi(async (url, init) => {
			active += 1;
			peak = Math.max(peak, active);
			try {
				if (url.searchParams.get('projectId') === 'app') {
					assert.ok(init.signal);
					started.resolve(init.signal);
					return await release.promise;
				}
				return jsonResponse({ schemaVersion: 1, traces: [traceSummary({ projectId: 'other' })], nextCursor: null });
			} finally { active -= 1; }
		});
		const controller = new TraceController('app');
		const first = controller.enable(api);
		const oldSignal = await started.promise;
		const second = controller.setProject('other');
		assert.strictEqual(oldSignal.aborted, true);
		release.resolve(jsonResponse({ schemaVersion: 1, traces: [traceSummary()], nextCursor: null }));
		await Promise.all([first, second]);
		assert.strictEqual(controller.state.projectId, 'other');
		assert.strictEqual(controller.state.traces[0]?.projectId, 'other');
		assert.strictEqual(peak, 1);
		controller.dispose();
	});

	test('disable and dispose abort an in-flight detail and never restore selection', async () => {
		for (const dispose of [false, true]) {
			const started = deferred<AbortSignal>();
			const release = deferred<Response>();
			const controller = new TraceController('app');
			await controller.enable(mockTraceApi(async (url, init) => {
				if (url.pathname === '/v2/traces') { return jsonResponse({ schemaVersion: 1, traces: [traceSummary()], nextCursor: null }); }
				assert.ok(init.signal);
				started.resolve(init.signal);
				return release.promise;
			}));
			const selecting = controller.select(traceId);
			const signal = await started.promise;
			if (dispose) { controller.dispose(); } else { controller.disable(); }
			assert.strictEqual(signal.aborted, true);
			release.resolve(jsonResponse({ schemaVersion: 1, spans: [storedSpan()], nextCursor: null }));
			await selecting;
			assert.strictEqual(controller.state.selectedTraceId, undefined);
			assert.deepStrictEqual(controller.state.spans, []);
			assert.strictEqual(controller.state.phase, 'disabled');
			controller.dispose();
		}
	});

	test('polls only while visible and enabled, coalesces refresh and stops when hidden', async () => {
		const timers = new Set<() => void>();
		const schedule: TraceSchedule = (callback, milliseconds) => {
			assert.strictEqual(milliseconds, 5_000);
			timers.add(callback);
			return () => { timers.delete(callback); };
		};
		let reads = 0;
		const controller = new TraceController('app', schedule);
		await controller.enable(mockTraceApi(async () => {
			reads += 1;
			return jsonResponse({ schemaVersion: 1, traces: [], nextCursor: null });
		}));
		assert.strictEqual(timers.size, 0);
		controller.setVisible(true);
		await controller.refresh();
		await controller.idle();
		assert.strictEqual(reads, 2);
		assert.strictEqual(timers.size, 1);
		controller.setVisible(false);
		assert.strictEqual(timers.size, 0);
		controller.disable();
		controller.setVisible(true);
		await controller.idle();
		assert.strictEqual(reads, 2);
		controller.dispose();
	});

	test('distinguishes empty, invalid project and request failure', async () => {
		const controller = new TraceController('app');
		await controller.enable(mockTraceApi(async () => jsonResponse({ schemaVersion: 1, traces: [], nextCursor: null })));
		assert.strictEqual(controller.state.phase, 'ready');
		assert.deepStrictEqual(controller.state.traces, []);
		await controller.setProject('bad/project');
		assert.strictEqual(controller.state.phase, 'error');
		assert.match(controller.state.notice, /Invalid project/);
		await controller.setProject('app');
		await controller.enable(mockTraceApi(async () => jsonResponse({}, 500)));
		assert.strictEqual(controller.state.phase, 'error');
		assert.match(controller.state.notice, /HTTP 500/);
		controller.dispose();
	});
});

suite('Trace pagination', () => {
	test('collects all pages and rejects repeated cursors and bounds', async () => {
		const signal = new AbortController().signal;
		const complete = await collectTracePages(async (cursor) => ({ items: [cursor ?? 'first'], nextCursor: cursor === undefined ? 'next' : null }), 100, 10_000, false, signal);
		assert.deepStrictEqual(complete.items, ['first', 'next']);
		assert.strictEqual(complete.pages, 2);
		await assert.rejects(collectTracePages(async () => ({ items: [], nextCursor: 'same' }), 100, 10_000, false, signal), /repeated/);
		await assert.rejects(collectTracePages(async () => ({ items: ['one'], nextCursor: 'more' }), 1, 10_000, false, signal), /page safety limit/);
		await assert.rejects(collectTracePages(async () => ({ items: ['one', 'two'], nextCursor: null }), 1, 1, false, signal), /safety limit/);
	});
});