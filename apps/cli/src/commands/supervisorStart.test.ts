import assert from 'node:assert/strict';
import { test } from 'node:test';

import { launchDetachedSupervisor } from 'model-worklog-supervisor';

import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import type { OutputStream } from '../output';
import { supervisorStartCommand } from './supervisorStart';

class Capture implements OutputStream {
	data = '';
	write(chunk: string): boolean {
		this.data += chunk;
		return true;
	}
}

test('starts the packaged supervisor and waits until its health endpoint is ready', async () => {
	const stdout = new Capture();
	const stderr = new Capture();
	const context: CommandContext = { stdout, stderr, env: {}, format: 'pretty', color: false, supervisorUrl: 'http://127.0.0.1:43199' };
	let probes = 0;
	let launched: { host: string; port: number } | undefined;
	const code = await supervisorStartCommand(context, {
		launch: (options) => {
			launched = { host: options.host, port: options.port };
			return {} as ReturnType<typeof launchDetachedSupervisor>;
		},
		fetchHealth: async () => {
			probes += 1;
			return probes === 1
				? { kind: 'unreachable', url: 'http://127.0.0.1:43199/health', message: 'ECONNREFUSED' }
				: { kind: 'ok', url: 'http://127.0.0.1:43199/health', health: { status: 'ok', supervisorVersion: '0.1.0', apiVersion: '1.0', schemaVersion: 1, instanceId: 'sup_cli', startedAt: '2026-09-15T12:00:00.000Z', capabilities: { adapters: [], features: [] } } };
		},
		delay: async () => undefined,
	});
	assert.equal(code, ExitCode.Ok);
	assert.deepEqual(launched, { host: '127.0.0.1', port: 43199 });
	assert.match(stdout.data, /started at http:\/\/127\.0\.0\.1:43199/);
	assert.equal(stderr.data, '');
});