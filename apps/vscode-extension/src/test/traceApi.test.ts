import * as assert from 'assert';
import { TraceApi, TraceApiError, canAccessTrace, type TraceFetch } from '../traceApi';

const origin = new URL('http://127.0.0.1:43199');
const principal = { id: 'reader-test', role: 'reader' as const, projects: ['app'] };
const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

suite('Trace API', () => {
	test('requires a direct schema-validated identity, not an envelope or an assumed admin', async () => {
		const api = new TraceApi(origin, async () => 'test-token', async () => response(principal));
		assert.deepStrictEqual(await api.identity(), principal);
		for (const body of [{ schemaVersion: 1, ...principal }, { principal }, { ...principal, role: 'owner' }]) {
			await assert.rejects(new TraceApi(origin, async () => 'test-token', async () => response(body)).identity(), /invalid trace data/);
		}
	});

	test('gates access by server identity, project and expiry', () => {
		assert.strictEqual(canAccessTrace(principal, 'app', 'read'), true);
		assert.strictEqual(canAccessTrace(principal, 'other', 'read'), false);
		assert.strictEqual(canAccessTrace(principal, 'app', 'admin'), false);
		assert.strictEqual(canAccessTrace({ ...principal, role: 'writer' }, 'app', 'read'), false);
		assert.strictEqual(canAccessTrace({ ...principal, role: 'admin', projects: ['*'] }, 'other', 'admin'), true);
		assert.strictEqual(canAccessTrace({ ...principal, expiresAt: '2000-01-01T00:00:00.000Z' }, 'app', 'read'), false);
		assert.strictEqual(canAccessTrace(undefined, 'app', 'read'), false);
	});

	test('uses only v2 endpoints, header credentials and explicit encoded pagination', async () => {
		const paths: string[] = [];
		const fetcher: TraceFetch = async (url, init) => {
			paths.push(url.pathname);
			assert.strictEqual(new Headers(init.headers).get('x-model-worklog-token'), 'test-token');
			assert.strictEqual(init.redirect, 'error');
			assert.ok(!url.href.includes('test-token'));
			if (url.pathname === '/v2/identity') { return response(principal); }
			assert.strictEqual(url.searchParams.get('projectId'), 'app');
			assert.strictEqual(url.searchParams.get('limit'), '50');
			assert.strictEqual(url.searchParams.get('cursor'), 'next+/=');
			return response({ schemaVersion: 1, traces: [], nextCursor: null });
		};
		assert.deepStrictEqual(await new TraceApi(origin, async () => 'test-token', fetcher).list('app', 'next+/='), { schemaVersion: 1, traces: [], nextCursor: null });
		assert.deepStrictEqual(paths, ['/v2/identity', '/v2/traces']);
	});

	test('does not send disallowed read, delete or create requests', async () => {
		for (const role of ['reader', 'writer'] as const) {
			const api = new TraceApi(origin, async () => 'test-token', async (url) => {
				assert.strictEqual(url.pathname, '/v2/identity');
				return response({ ...principal, role });
			});
			await assert.rejects(api.deleteTrace('app', '1'.repeat(32)), /admin credential/);
			await assert.rejects(api.createWriter('app'), /admin credential/);
			await assert.rejects(api.list('other'), /reader or admin/);
			if (role === 'writer') { await assert.rejects(api.list('app'), /reader or admin/); }
		}
	});

	test('rejects malformed list and detail responses and suppresses server error content', async () => {
		for (const body of [{ traces: [] }, { schemaVersion: 1, traces: [], nextCursor: 3 }, { schemaVersion: 1, spans: [{ span: {} }], nextCursor: null }]) {
			const api = new TraceApi(origin, async () => 'test-token', async (url) => response(url.pathname === '/v2/identity' ? principal : body));
			await assert.rejects(api.list('app'), /invalid trace data/);
			await assert.rejects(api.detail('app', '1'.repeat(32)), /invalid trace data/);
		}
		const api = new TraceApi(origin, async () => 'test-token', async () => response({ error: 'secret-token' }, 401));
		await assert.rejects(api.identity(), (error: unknown) => error instanceof TraceApiError && error.kind === 'unauthorized' && !error.message.includes('secret-token'));
	});

	test('rejects unsafe origins and aborts before sending a request', async () => {
		for (const url of ['https://example.com', 'http://user:pass@localhost', 'http://localhost/?token=secret', 'http://localhost/path']) {
			assert.throws(() => new TraceApi(new URL(url)), /loopback HTTP origin/);
		}
		const abort = new AbortController();
		abort.abort();
		const api = new TraceApi(origin, async () => 'test-token', async () => { throw new Error('Must not fetch'); });
		await assert.rejects(api.identity(abort.signal), { name: 'AbortError' });
	});
});