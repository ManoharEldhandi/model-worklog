import * as assert from 'assert';
import * as vscode from 'vscode';
import { codexSessionPath, deleteSession, evidenceBundlePath, parseCommandArray, sessionEventQueryPath } from '../supervisorApi';
import { bundledSupervisorPath, supervisorEnvironment } from '../supervisorRuntime';
import { SupervisorRuntime } from '../supervisorRuntime';
import { describeConnection, interpretHealthJson } from '../supervisorClient';
import { logDownloadFileName, presentSession } from '../sessionPresentation';
import { SidebarLogView } from '../sidebarLogView';
import { buildLogDetail } from '../logDetailPresentation';
import { formatSessionEventText, type SessionEvent } from 'model-worklog-schema';

suite('Extension Test Suite', () => {
	test('builds the Model Logger Codex session endpoint', () => {
		assert.strictEqual(codexSessionPath(), '/v1/codex-sessions');
	});

	test('registers the bottom Model Logger detail panel', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('workbench.view.extension.model-worklog-details'));
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

suite('Delete log API', () => {
	test('sends a delete request and requires a matching completed-log response', async () => {
		const originalFetch = global.fetch;
		try {
			global.fetch = async (input, init) => {
				assert.strictEqual(new URL(input).pathname, '/v1/sessions/ses_demo');
				assert.strictEqual(init?.method, 'DELETE');
				return new Response(JSON.stringify({ sessionId: 'ses_demo', deleted: true }), { status: 200 });
			};
			await deleteSession(new URL('http://127.0.0.1:43199'), 'ses_demo');
		} finally {
			global.fetch = originalFetch;
		}
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
		const lines = formatSessionEventText({
			schemaVersion: 1, eventId: 'evt_1', sessionId: 'ses_1', sequence: 1, occurredAt: '2026-09-15T12:00:00.000Z', kind: 'agent.summary', actor: 'codex-app-server', evidenceGrade: 'observed-native',
			payload: { summary: 'Tracing the failed assertion.', source: 'reasoning-summary' }, redaction: { policyVersion: '1', replacements: 0, truncated: false },
		});
		assert.ok(lines.some((line) => line.includes('Tracing the failed assertion.')));
		assert.strictEqual(lines.some((line) => line.includes('{"summary"')), false);
	});

	test('names the target file for a read-style tool event', () => {
		const lines = formatSessionEventText({
			schemaVersion: 1, eventId: 'evt_2', sessionId: 'ses_1', sequence: 2, occurredAt: '2026-09-15T12:00:01.000Z', kind: 'tool.called', actor: 'codex-app-server', evidenceGrade: 'observed-native',
			payload: { tool: 'read_file', arguments: { path: 'src/app.ts' } }, redaction: { policyVersion: '1', replacements: 0, truncated: false },
		});
		assert.ok(lines.some((line) => line.includes('Tool started: read_file')));
		assert.ok(lines.some((line) => line.includes('Target file: src/app.ts')));
	});
});

suite('Log session presentation', () => {
	test('distinguishes live Codex logs and unavailable usage in the tree', () => {
		const presentation = presentSession({
			sessionId: 'ses_live', state: 'running', runMode: 'managed', actor: 'codex-app-server', eventCount: 14,
			tokenUsage: { status: 'unknown', reason: 'not-observed' },
		});
		assert.strictEqual(presentation.title, 'Codex log');
		assert.strictEqual(presentation.description, 'Live · 14 updates');
		assert.strictEqual(presentation.icon, 'sync~spin');
		assert.ok(presentation.tooltip.includes('ses_live'));
		assert.ok(presentation.tooltip.includes('Token count: not reported yet'));
	});

	test('shows reported token totals only when the AI integration supplied them', () => {
		const presentation = presentSession({
			sessionId: 'ses_tokens', state: 'completed', runMode: 'observe', actor: 'openai-agent', eventCount: 6,
			tokenUsage: { status: 'reported', source: 'provider-reported', providers: ['openai'], models: ['gpt-example'], inputTokens: 40, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 60 },
		});
		assert.strictEqual(presentation.description, 'Completed · 6 updates · 60 tokens');
		assert.ok(presentation.tooltip.includes('Token count: 60 tokens'));
	});

	test('uses the task title for log names and JSON downloads', () => {
		const session = {
			sessionId: 'ses_12345678', title: 'Fix parser test output', state: 'completed', runMode: 'observe', actor: 'example-agent', eventCount: 3,
			tokenUsage: { status: 'unknown', reason: 'not-observed' } as const,
		};
		assert.strictEqual(presentSession(session).title, 'Fix parser test output');
		assert.strictEqual(logDownloadFileName(session), 'fix-parser-test-output-12345678.json');
	});
});

suite('Sidebar activity UI', () => {
	test('shows only enable while disabled and only view or download actions inside a log', () => {
		const view = new SidebarLogView();
		try {
			assert.deepStrictEqual(view.getChildren().map((item) => item.kind === 'action' ? item.action : item.kind), ['connection', 'enable']);
			view.setLoggerState(true, 'connected', 'Local Logger is ready.');
			view.setSessions([{
				sessionId: 'ses_live', state: 'running', runMode: 'observe', actor: 'example-agent', eventCount: 1,
				tokenUsage: { status: 'unknown', reason: 'not-observed' },
			}]);
			const liveGroup = view.getChildren().find((item) => item.kind === 'group' && item.group === 'live');
			assert.ok(liveGroup !== undefined);
			if (liveGroup === undefined) {
				return;
			}
			const log = view.getChildren(liveGroup)[0];
			assert.ok(log !== undefined && log.kind === 'session');
			if (log === undefined || log.kind !== 'session') {
				return;
			}
			assert.strictEqual(view.getParent(log), liveGroup);
			assert.deepStrictEqual(view.getChildren(log).map((item) => item.kind === 'action' ? item.action : item.kind), ['view-log', 'download-json']);
		} finally {
			view.dispose();
		}
	});

	test('provides the Live Activity parent for each active log', () => {
		const view = new SidebarLogView();
		try {
			view.setLoggerState(true, 'connected', 'Local Logger is ready.');
			view.setSessions([{
				sessionId: 'ses_reveal', state: 'running', runMode: 'observe', actor: 'example-agent', eventCount: 1,
				tokenUsage: { status: 'unknown', reason: 'not-observed' },
			}]);
			const liveGroup = view.getChildren().find((item) => item.kind === 'group' && item.group === 'live');
			assert.ok(liveGroup !== undefined);
			if (liveGroup !== undefined) {
				assert.strictEqual(view.getParent(view.sessionItem('ses_reveal')), liveGroup);
			}
		} finally {
			view.dispose();
		}
	});

	test('offers Delete Log only after a session finishes', () => {
		const view = new SidebarLogView();
		try {
			view.setLoggerState(true, 'connected', 'Local Logger is ready.');
			view.setSessions([{ sessionId: 'ses_live', state: 'running', runMode: 'observe', actor: 'agent', eventCount: 1, tokenUsage: { status: 'unknown', reason: 'not-observed' } }]);
			assert.deepStrictEqual(view.getChildren(view.sessionItem('ses_live')).map((item) => item.kind === 'action' ? item.action : item.kind), ['view-log', 'download-json']);
			view.setSessions([{ sessionId: 'ses_done', state: 'completed', runMode: 'observe', actor: 'agent', eventCount: 2, tokenUsage: { status: 'unknown', reason: 'not-observed' } }]);
			assert.deepStrictEqual(view.getChildren(view.sessionItem('ses_done')).map((item) => item.kind === 'action' ? item.action : item.kind), ['view-log', 'download-json', 'delete-log']);
		} finally {
			view.dispose();
		}
	});
});

suite('Selected log details', () => {
	test('shows requests, plans, tool activity, and live token totals in one ordered view', () => {
		const session = {
			sessionId: 'ses_details', state: 'running', runMode: 'observe', actor: 'example-agent', eventCount: 6,
			tokenUsage: { status: 'unknown', reason: 'not-observed' } as const,
		};
		const events: SessionEvent[] = [
			{ schemaVersion: 1, eventId: 'evt_1', sessionId: 'ses_details', sequence: 1, occurredAt: '2026-09-15T12:00:00.000Z', kind: 'agent.message' as const, actor: 'example-agent', evidenceGrade: 'model-declared' as const, payload: { role: 'user', text: 'Review the parser.' }, redaction: { policyVersion: '1', replacements: 0, truncated: false } },
			{ schemaVersion: 1, eventId: 'evt_2', sessionId: 'ses_details', sequence: 2, occurredAt: '2026-09-15T12:00:01.000Z', kind: 'agent.summary' as const, actor: 'example-agent', evidenceGrade: 'model-declared' as const, payload: { source: 'plan', summary: 'Read source, then run tests.' }, redaction: { policyVersion: '1', replacements: 0, truncated: false } },
			{ schemaVersion: 1, eventId: 'evt_3', sessionId: 'ses_details', sequence: 3, occurredAt: '2026-09-15T12:00:02.000Z', kind: 'tool.called' as const, actor: 'example-agent', evidenceGrade: 'model-declared' as const, payload: { tool: 'read_file', arguments: { path: 'src/parser.ts' } }, redaction: { policyVersion: '1', replacements: 0, truncated: false } },
			{ schemaVersion: 1, eventId: 'evt_4', sessionId: 'ses_details', sequence: 4, occurredAt: '2026-09-15T12:00:03.000Z', kind: 'tool.completed' as const, actor: 'example-agent', evidenceGrade: 'model-declared' as const, payload: { tool: 'read_file', success: true, result: { linesRead: 40 } }, redaction: { policyVersion: '1', replacements: 0, truncated: false } },
			{ schemaVersion: 1, eventId: 'evt_5', sessionId: 'ses_details', sequence: 5, occurredAt: '2026-09-15T12:00:04.000Z', kind: 'usage.reported' as const, actor: 'example-agent', evidenceGrade: 'model-declared' as const, payload: { provider: 'openai', model: 'gpt-example', inputTokens: 30, outputTokens: 10, reasoningTokens: 2, totalTokens: 40 }, redaction: { policyVersion: '1', replacements: 0, truncated: false } },
			{ schemaVersion: 1, eventId: 'evt_6', sessionId: 'ses_details', sequence: 6, occurredAt: '2026-09-15T12:00:05.000Z', kind: 'agent.summary' as const, actor: 'example-agent', evidenceGrade: 'model-declared' as const, payload: { summary: 'The parser was reviewed and the focused test passed.' }, redaction: { policyVersion: '1', replacements: 0, truncated: false } },
		];
		const detail = buildLogDetail(session, events);
		assert.strictEqual(detail.title, 'Review the parser.');
		assert.deepStrictEqual(detail.sections.map((section) => section.title), ['User Request', 'Agent Plan', 'Tools Used', 'Agent Response', 'Tokens Used']);
		assert.equal(detail.sections[0]?.entries[0]?.content, 'Review the parser.');
		assert.equal(detail.sections[1]?.entries[0]?.content, 'Plan:\nRead source, then run tests.');
		assert.ok(detail.sections[2]?.entries.some((entry) => entry.label.includes('read_file selected')));
		assert.equal(detail.sections[3]?.entries[0]?.content, 'The parser was reviewed and the focused test passed.');
		assert.deepStrictEqual(detail.sections.at(-1)?.entries.slice(0, 4).map((entry) => entry.label), ['Total: 40', 'Input: 30', 'Output: 10', 'Reasoning: 2']);
	});
});
