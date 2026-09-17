import * as assert from 'assert';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { copilotHookPath, installCopilotHook, removeCopilotHook } from '../copilotHookInstaller';
import { codexSessionPath, copilotInteractiveSessionPath, copilotSessionPath, deleteSession, evidenceBundlePath, extensionClientPath, sessionEventQueryPath } from '../supervisorApi';
import { bundledSupervisorPath, supervisorEnvironment } from '../supervisorRuntime';
import { SupervisorRuntime } from '../supervisorRuntime';
import { describeConnection, interpretHealthJson, missingSupervisorFeatures } from '../supervisorClient';
import { logDownloadFileName, presentSession } from '../sessionPresentation';
import { SidebarLogView } from '../sidebarLogView';
import { buildLogDetail } from '../logDetailPresentation';
import { logDetailsHtml } from '../logDetailsView';
import { formatSessionEventText, type SessionEvent } from 'model-worklog-schema';

suite('Extension Test Suite', () => {
	test('builds the Model Logger Codex session endpoint', () => {
		assert.strictEqual(codexSessionPath(), '/v1/codex-sessions');
	});

	test('builds the Model Logger Copilot CLI session endpoint', () => {
		assert.strictEqual(copilotSessionPath(), '/v1/copilot-sessions');
	});

	test('builds the tracked interactive Copilot CLI session endpoint', () => {
		assert.strictEqual(copilotInteractiveSessionPath(), '/v1/copilot-interactive-sessions');
	});

	test('runs the interactive Copilot bridge as Node from the Electron extension host', async () => {
		const source = await readFile(join(__dirname, '..', 'extension.js'), 'utf8');
		assert.ok(source.includes("ELECTRON_RUN_AS_NODE: '1'"));
		assert.ok(source.includes('shellPath: process.execPath'));
		assert.ok(source.includes("'copilot-interactive-bridge.js'"));
	});

	test('builds an encoded extension client lease endpoint', () => {
		assert.strictEqual(extensionClientPath(), '/v1/extension-clients');
		assert.strictEqual(extensionClientPath('vscode/window'), '/v1/extension-clients/vscode%2Fwindow');
	});

	test('registers the bottom Model Logger detail panel', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('workbench.view.extension.model-worklog-details'));
	});

	test('renders a compact expandable log-entry control in the detail webview', () => {
		const markup = logDetailsHtml();
		assert.ok(markup.includes('max-height: 2.9em'));
		assert.ok(markup.includes('value.split(/\\r?\\n/)'));
		assert.ok(markup.includes('const expandedEntries = new Set'));
		assert.ok(markup.includes('vscode.setState({ sessionId: selectedSessionId, expandedEntries: [...expandedEntries] })'));
		assert.ok(markup.includes('if (selectedSessionId !== model.sessionId)'));
		assert.ok(markup.includes("toggle.textContent = expanded ? 'Show less' : 'Show more'"));
		const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(markup)?.[1];
		assert.ok(script !== undefined);
		assert.doesNotThrow(() => new Function(script));
	});

	test('installs and removes only the Model Logger Copilot CLI personal hook', async () => {
		const copilotHome = await mkdtemp(join(tmpdir(), 'model-worklog-copilot-home-'));
		const environment = { COPILOT_HOME: copilotHome } as NodeJS.ProcessEnv;
		try {
			const path = await installCopilotHook({ bridgePath: '/extension/dist/copilot-hook-bridge.js', supervisorUrl: 'http://127.0.0.1:43199/', modelWorklogHome: '/model-worklog' }, environment);
			assert.strictEqual(path, copilotHookPath(environment));
			const config = JSON.parse(await readFile(path, 'utf8')) as { version: number; hooks: Record<string, { exec: string; args: string[]; env: Record<string, string> }[]> };
			assert.strictEqual(config.version, 1);
			assert.deepStrictEqual(Object.keys(config.hooks), ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'SubagentStop', 'SessionEnd', 'ErrorOccurred']);
			assert.deepStrictEqual(config.hooks.SessionStart?.[0], {
				type: 'command', exec: 'node', args: ['/extension/dist/copilot-hook-bridge.js'],
				env: { MODEL_WORKLOG_HOOK_BRIDGE: '1', MODEL_WORKLOG_SUPERVISOR_URL: 'http://127.0.0.1:43199/', MODEL_WORKLOG_HOME: '/model-worklog' }, timeoutSec: 3,
			});
			await removeCopilotHook(environment);
			await assert.rejects(() => access(path));
		} finally {
			await rm(copilotHome, { recursive: true, force: true });
		}
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

	test('detects a supervisor that lacks required client lease support', () => {
		const connection = interpretHealthJson(validHealth);
		assert.deepStrictEqual(missingSupervisorFeatures(connection, ['vscode-client-leases', 'copilot-hook-turn-completion']), ['vscode-client-leases', 'copilot-hook-turn-completion']);
		assert.deepStrictEqual(missingSupervisorFeatures(interpretHealthJson({ ...validHealth, capabilities: { adapters: [], features: ['vscode-client-leases', 'copilot-hook-turn-completion'] } }), ['vscode-client-leases', 'copilot-hook-turn-completion']), []);
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
		assert.strictEqual(environment.MODEL_WORKLOG_SHUTDOWN_WHEN_IDLE, '1');
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
		assert.ok(lines.some((line) => line.includes('Target path: src/app.ts')));
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

	test('labels direct Copilot CLI sessions as native agent evidence', () => {
		const presentation = presentSession({
			sessionId: 'ses_copilot', state: 'running', runMode: 'managed', actor: 'copilot-cli', eventCount: 4,
			tokenUsage: { status: 'unknown', reason: 'not-observed' },
		});
		assert.strictEqual(presentation.title, 'Copilot CLI log');
		assert.ok(presentation.tooltip.includes('documented Copilot CLI messages'));
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
			assert.deepStrictEqual(view.getChildren(log).map((item) => item.kind === 'action' ? item.action : item.kind), ['stop-log', 'view-log', 'download-json']);
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

	test('opens a log directly when its sidebar session item is selected', () => {
		const view = new SidebarLogView();
		try {
			view.setLoggerState(true, 'connected', 'Local Logger is ready.');
			view.setSessions([{
				sessionId: 'ses_open', state: 'completed', runMode: 'observe', actor: 'example-agent', eventCount: 1,
				tokenUsage: { status: 'unknown', reason: 'not-observed' },
			}]);
			const item = view.getTreeItem(view.sessionItem('ses_open'));
			assert.strictEqual(item.command?.command, 'model-worklog.openSessionLog');
			assert.deepStrictEqual(item.command?.arguments, ['ses_open']);
		} finally {
			view.dispose();
		}
	});

	test('hides legacy workspace and terminal observer sessions', () => {
		const view = new SidebarLogView();
		try {
			view.setLoggerState(true, 'connected', 'Local Logger is ready.');
			view.setSessions([
				{ sessionId: 'ses_workspace', state: 'running', runMode: 'observe', actor: 'workspace-observer', eventCount: 18_000, tokenUsage: { status: 'unknown', reason: 'not-observed' } },
				{ sessionId: 'ses_terminal', state: 'running', runMode: 'observe', actor: 'vscode-terminal', eventCount: 3, tokenUsage: { status: 'unknown', reason: 'not-observed' } },
				{ sessionId: 'ses_agent', state: 'running', runMode: 'observe', actor: 'example-agent', eventCount: 4, tokenUsage: { status: 'unknown', reason: 'not-observed' } },
			]);
			const liveGroup = view.getChildren().find((item) => item.kind === 'group' && item.group === 'live');
			assert.ok(liveGroup !== undefined);
			if (liveGroup !== undefined) {
				assert.deepStrictEqual(view.getChildren(liveGroup).map((item) => item.kind === 'session' ? item.sessionId : item.kind), ['ses_agent']);
			}
		} finally {
			view.dispose();
		}
	});

	test('keeps the latest agent session available when legacy sessions precede it', () => {
		const view = new SidebarLogView();
		try {
			view.setLoggerState(true, 'connected', 'Local Logger is ready.');
			view.setSessions([
				{ sessionId: 'ses_legacy', state: 'completed', runMode: 'observe', actor: 'workspace-observer', eventCount: 1, tokenUsage: { status: 'unknown', reason: 'not-observed' } },
				{ sessionId: 'ses_latest', state: 'completed', runMode: 'observe', actor: 'copilot-cli-hook', eventCount: 2, tokenUsage: { status: 'unknown', reason: 'not-observed' } },
			]);
			assert.strictEqual(view.getSession('ses_legacy'), undefined);
			assert.ok(view.getSession('ses_latest') !== undefined);
		} finally {
			view.dispose();
		}
	});

	test('offers Delete Log only after a session finishes', () => {
		const view = new SidebarLogView();
		try {
			view.setLoggerState(true, 'connected', 'Local Logger is ready.');
			view.setSessions([{ sessionId: 'ses_live', state: 'running', runMode: 'observe', actor: 'agent', eventCount: 1, tokenUsage: { status: 'unknown', reason: 'not-observed' } }]);
			assert.deepStrictEqual(view.getChildren(view.sessionItem('ses_live')).map((item) => item.kind === 'action' ? item.action : item.kind), ['stop-log', 'view-log', 'download-json']);
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

	test('keeps complete entry content in the detail model for compact webview expansion and JSON export', () => {
		const response = 'line one\nline two\nline three\n'.repeat(150);
		const session = {
			sessionId: 'ses_full_content', state: 'completed', runMode: 'observe', actor: 'example-agent', eventCount: 2,
			tokenUsage: { status: 'unknown', reason: 'not-observed' } as const,
		};
		const detail = buildLogDetail(session, [
			{ schemaVersion: 1, eventId: 'evt_request', sessionId: session.sessionId, sequence: 1, occurredAt: '2026-09-17T06:00:00.000Z', kind: 'agent.message', actor: 'example-agent', evidenceGrade: 'model-declared', payload: { role: 'user', text: 'Summarize the result.' }, redaction: { policyVersion: '1', replacements: 0, truncated: false } },
			{ schemaVersion: 1, eventId: 'evt_response', sessionId: session.sessionId, sequence: 2, occurredAt: '2026-09-17T06:00:01.000Z', kind: 'agent.message', actor: 'example-agent', evidenceGrade: 'model-declared', payload: { role: 'assistant', text: response }, redaction: { policyVersion: '1', replacements: 0, truncated: false } },
		]);
		const agentResponse = detail.sections.find((section) => section.title === 'Agent Response')?.entries[0]?.content;
		assert.strictEqual(agentResponse, response);
	});

	test('keeps token availability in the final section when an integration does not report usage', () => {
		const session = {
			sessionId: 'ses_unknown_tokens', state: 'completed', runMode: 'observe', actor: 'copilot-cli-hook', eventCount: 1,
			tokenUsage: { status: 'unknown', reason: 'not-observed' } as const,
		};
		const detail = buildLogDetail(session, [
			{ schemaVersion: 1, eventId: 'evt_request', sessionId: session.sessionId, sequence: 1, occurredAt: '2026-09-17T06:00:00.000Z', kind: 'agent.message', actor: 'copilot-cli-hook', evidenceGrade: 'model-declared', payload: { role: 'user', text: 'Inspect the task.' }, redaction: { policyVersion: '1', replacements: 0, truncated: false } },
		]);
		assert.strictEqual(detail.sections.at(-1)?.title, 'Tokens Used');
		assert.deepStrictEqual(detail.sections.at(-1)?.entries, [{
			label: 'Unavailable from Copilot CLI hook',
			content: 'Copilot CLI does not provide token usage to automatic hooks. Use Log a Copilot CLI Task to record provider-reported usage.',
		}]);
	});
});
