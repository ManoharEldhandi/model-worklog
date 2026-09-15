import * as assert from 'assert';
import { codexSessionPath, evidenceBundlePath, parseCommandArray, sessionEventQueryPath } from '../supervisorApi';
import { bundledSupervisorPath, supervisorEnvironment } from '../supervisorRuntime';
import { SupervisorRuntime } from '../supervisorRuntime';
import { formatSessionEvent } from '../eventPresentation';
import { describeConnection, interpretHealthJson } from '../supervisorClient';

suite('Extension Test Suite', () => {
	test('builds the Model Logger Codex session endpoint', () => {
		assert.strictEqual(codexSessionPath(), '/v1/codex-sessions');
	});
});

suite('Supervisor client', () => {
	const validHealth = {
		status: 'ok',
		supervisorVersion: '0.1.0',
		apiVersion: '1.0',
		schemaVersion: 1,
		instanceId: 'sup_x',
		startedAt: '2026-09-11T14:00:00.000Z',
		capabilities: { adapters: [], features: ['health'] },
	};

	test('interprets a valid health body as connected', () => {
		const connection = interpretHealthJson(validHealth);
		assert.strictEqual(connection.kind, 'connected');
	});

	test('flags an incompatible API major', () => {
		const connection = interpretHealthJson({ ...validHealth, apiVersion: '2.0' });
		assert.strictEqual(connection.kind, 'incompatible');
	});

	test('rejects a malformed health body', () => {
		assert.strictEqual(interpretHealthJson({ status: 'ok' }).kind, 'malformed');
		assert.strictEqual(interpretHealthJson(null).kind, 'malformed');
	});

	test('describeConnection returns a label and detail', () => {
		const detail = describeConnection(interpretHealthJson(validHealth));
		assert.ok(detail.label.includes('connected'));
		assert.ok(detail.detail.length > 0);
	});
});

suite('Managed command input', () => {
	test('accepts an explicit string argument vector and rejects shell-like input', () => {
		assert.deepStrictEqual(parseCommandArray('["npm", "test", "--", "file name"]'), ['npm', 'test', '--', 'file name']);
		assert.strictEqual(parseCommandArray('npm test'), undefined);
		assert.strictEqual(parseCommandArray('["npm", 1]'), undefined);
		assert.strictEqual(parseCommandArray('[]'), undefined);
	});
});

suite('Session event query', () => {
	test('builds a resumable, filterable event query', () => {
		const path = sessionEventQueryPath('ses/demo', {
			afterSequence: 4, kinds: ['file.changed', 'command.completed'], grades: ['observed-boundary'], actors: ['boundary'], path: 'src/app', command: 'npm test',
		});
		const url = new URL(path, 'http://localhost');
		assert.strictEqual(url.pathname, '/v1/sessions/ses%2Fdemo/events');
		assert.strictEqual(url.searchParams.get('afterSequence'), '4');
		assert.deepStrictEqual(url.searchParams.getAll('kind'), ['file.changed', 'command.completed']);
		assert.strictEqual(url.searchParams.get('grade'), 'observed-boundary');
		assert.strictEqual(url.searchParams.get('actor'), 'boundary');
		assert.strictEqual(url.searchParams.get('path'), 'src/app');
		assert.strictEqual(url.searchParams.get('command'), 'npm test');
	});
});

suite('Evidence bundle API', () => {
	test('builds an encoded session evidence bundle path', () => {
		assert.strictEqual(evidenceBundlePath('ses/demo'), '/v1/sessions/ses%2Fdemo/evidence-bundle');
	});
});

suite('Bundled supervisor runtime', () => {
	test('resolves a packaged entry point and accepts only loopback startup targets', () => {
		assert.ok(bundledSupervisorPath('/extensions/model-worklog').endsWith('/dist/supervisor.js'));
		const environment = supervisorEnvironment(new URL('http://127.0.0.1:43199'), { MODEL_WORKLOG_SUPERVISOR_HOST: '0.0.0.0' });
		assert.strictEqual(environment.MODEL_WORKLOG_SUPERVISOR_PORT, '43199');
		assert.strictEqual(environment.MODEL_WORKLOG_SUPERVISOR_HOST, '127.0.0.1');
		assert.strictEqual(supervisorEnvironment(new URL('http://localhost')).MODEL_WORKLOG_SUPERVISOR_PORT, '43199');
		assert.throws(() => supervisorEnvironment(new URL('https://example.test:43199')), /loopback HTTP URL/);
	});

	test('reuses a supervisor that becomes healthy after a concurrent startup race', async () => {
		let probes = 0;
		let spawned = 0;
		const runtime = new SupervisorRuntime({
			extensionPath: '/extensions/model-worklog',
			spawnSupervisor: () => ({ exitCode: 1, once: () => undefined, unref: () => { spawned += 1; } }),
			probe: async () => {
				probes += 1;
				return probes === 1
					? { kind: 'unreachable', message: 'ECONNREFUSED' }
					: { kind: 'connected', health: { status: 'ok', supervisorVersion: '0.1.0', apiVersion: '1.0', schemaVersion: 1, instanceId: 'sup_race', startedAt: '2026-09-15T12:00:00.000Z', capabilities: { adapters: ['codex-app-server'], features: ['health'] } } };
			},
		});
		const connection = await runtime.ensureRunning(new URL('http://127.0.0.1:43199'));
		assert.strictEqual(connection.kind, 'connected');
		assert.strictEqual(spawned, 1);
	});
});

suite('Readable session evidence', () => {
	test('renders visible Codex activity as human-readable evidence rather than JSON', () => {
		const lines = formatSessionEvent({
			schemaVersion: 1, eventId: 'evt_1', sessionId: 'ses_1', sequence: 1, occurredAt: '2026-09-15T12:00:00.000Z', kind: 'agent.summary', actor: 'codex-app-server', evidenceGrade: 'observed-native',
			payload: { summary: 'Tracing the failed assertion.', source: 'reasoning-summary' }, redaction: { policyVersion: '1', replacements: 0, truncated: false },
		});
		assert.ok(lines.some((line) => line.includes('Tracing the failed assertion.')));
		assert.strictEqual(lines.some((line) => line.includes('{"summary"')), false);
	});

	test('names the target file for a read-style tool event', () => {
		const lines = formatSessionEvent({
			schemaVersion: 1, eventId: 'evt_2', sessionId: 'ses_1', sequence: 2, occurredAt: '2026-09-15T12:00:01.000Z', kind: 'tool.called', actor: 'codex-app-server', evidenceGrade: 'observed-native',
			payload: { tool: 'read_file', arguments: { path: 'src/app.ts' } }, redaction: { policyVersion: '1', replacements: 0, truncated: false },
		});
		assert.ok(lines.some((line) => line.includes('read_file on src/app.ts')));
	});
});
