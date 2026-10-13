import * as assert from 'assert';
import * as vscode from 'vscode';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TraceApi } from '../traceApi';
import { TraceController } from '../traceController';
import { TraceSidebar } from '../traceSidebar';
import { SupervisorRuntime } from '../supervisorRuntime';
import { jsonResponse, traceSummary } from './traceFixtures';

suite('Native trace views', () => {
	test('contributes Traces alongside Logs and retains the legacy detail view and commands', async () => {
		const extension = vscode.extensions.getExtension('manohareldhandi.model-worklog');
		assert.ok(extension);
		await extension.activate();
		const commands = await vscode.commands.getCommands(true);
		for (const command of ['model-worklog.traces.focus', 'model-worklog.traceDetails.focus', 'model-worklog.sessions.focus', 'model-worklog.logDetails.focus', 'model-worklog.trace.configureSdk', 'model-worklog.startCopilotInteractiveSession']) {
			assert.ok(commands.includes(command), command);
		}
		const manifest = JSON.parse(await readFile(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { contributes: { configuration: { properties: Record<string, { default?: unknown }> } } };
		assert.strictEqual(manifest.contributes.configuration.properties['model-worklog.trace.projectId']?.default, 'default');
	});

	test('uses actual identity roles for native actions and preserves trace item IDs across refresh', async () => {
		for (const role of ['admin', 'reader', 'writer'] as const) {
			const controller = new TraceController('app');
			const sidebar = new TraceSidebar(controller);
			const api = new TraceApi(new URL('http://127.0.0.1:43199'), async () => 'isolated-native-test', async (url) =>
				jsonResponse(url.pathname === '/v2/identity' ? { id: 'test-identity', role, projects: ['app'] } : { schemaVersion: 1, traces: [traceSummary()], nextCursor: null }));
			try {
				await controller.enable(api);
				const rows = sidebar.getChildren();
				assert.strictEqual(rows.some((row) => row.kind === 'setup'), role === 'admin');
				const trace = rows.find((row) => row.kind === 'trace');
				if (role === 'writer') { assert.strictEqual(trace, undefined); assert.strictEqual(controller.state.phase, 'unauthorized'); continue; }
				assert.ok(trace);
				const before = sidebar.getTreeItem(trace);
				assert.strictEqual(before.contextValue, role === 'admin' ? 'trace-admin' : 'trace-reader');
				assert.match(String(before.description), /test-service.*1 spans.*not reported/);
				await controller.refresh();
				const after = sidebar.getChildren().find((row) => row.kind === 'trace');
				assert.ok(after);
				assert.strictEqual(sidebar.getTreeItem(after).id, before.id);
			} finally { sidebar.dispose(); controller.dispose(); }
		}
	});
});

suite('Real Electron Node supervisor launcher', () => {
	test('starts the bundled supervisor with Electron-as-Node and an isolated data directory', async function () {
		this.timeout(20_000);
		assert.ok(process.versions.electron, 'This regression must run in the real extension host.');
		const directory = await mkdtemp(join(tmpdir(), 'model-worklog-electron-launch-'));
		const reservation = createServer();
		await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
		const address = reservation.address();
		assert.ok(address !== null && typeof address !== 'string');
		await new Promise<void>((resolve, reject) => reservation.close((error) => error === undefined ? resolve() : reject(error)));
		const url = new URL(`http://127.0.0.1:${address.port}`);
		let child: ChildProcess | undefined;
		let stopped = Promise.resolve();
		let stderr = '';
		const runtime = new SupervisorRuntime({ extensionPath: join(__dirname, '..', '..'), spawnSupervisor: (command, argumentsValue, options) => {
			assert.strictEqual(command, process.execPath);
			assert.strictEqual(options.env.ELECTRON_RUN_AS_NODE, '1');
			child = spawn(command, argumentsValue, { ...options, detached: false, stdio: 'pipe', env: { ...options.env, MODEL_WORKLOG_HOME: directory } });
			child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
			const running = child;
			stopped = new Promise<void>((resolve) => { running.once('exit', () => resolve()); running.once('error', () => resolve()); });
			return child;
		} });
		try {
			const connection = await runtime.ensureRunning(url);
			assert.strictEqual(connection.kind, 'connected', stderr);
			const api = new TraceApi(url, async () => (await readFile(join(directory, 'auth-token'), 'utf8')).trim());
			assert.strictEqual((await api.identity()).role, 'admin');
			assert.deepStrictEqual((await api.list('default')).traces, []);
		} finally {
			child?.kill('SIGTERM');
			const forceStop = setTimeout(() => child?.kill('SIGKILL'), 3_000);
			await stopped;
			clearTimeout(forceStop);
			await rm(directory, { recursive: true, force: true });
		}
	});
});