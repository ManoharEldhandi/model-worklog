import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

// Controlled agent boundary for repeatable tests; file reads and test execution are real.
export const workspaceRelay = (sink, options, onFinished) => ({
	async start() {
		const base = { actor: 'codex-test-driver', evidenceGrade: 'observed-boundary' };
		for (const path of ['src/pricing.ts', 'test/pricing.test.ts']) {
			await sink.append({ ...base, correlationId: path, kind: 'tool.called', payload: { tool: 'read_file', arguments: { path } } });
			await sink.append({ ...base, correlationId: path, kind: 'file.read', payload: { path, tool: 'read_file' } });
			await sink.append({ ...base, correlationId: path, kind: 'tool.completed', payload: { tool: 'read_file', success: true, result: await readFile(join(options.workspacePath, path), 'utf8') } });
		}
		await sink.append({ ...base, correlationId: 'tests', kind: 'command.started', payload: { executable: 'npm test' } });
		const result = await new Promise((resolve) => execFile(process.execPath, ['--experimental-strip-types', '--test', 'test/inventory.test.ts', 'test/pricing.test.ts'], { cwd: options.workspacePath, env: { ...process.env, NODE_TEST_CONTEXT: undefined } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr })));
		await sink.append({ ...base, correlationId: 'tests', kind: 'process.output', payload: { stream: 'stdout', text: result.output } });
		await sink.append({ ...base, correlationId: 'tests', kind: 'command.completed', payload: { executable: 'npm test', exitCode: result.code } });
		await sink.append({ ...base, kind: 'agent.message', payload: { role: 'assistant', text: 'Six tests passed; negative quantities must be rejected failed because quotedPrice accepts a negative quantity.' } });
		await sink.complete('completed'); onFinished(options.sessionId);
	}, async cancel() {}, async shutdown() {},
});
