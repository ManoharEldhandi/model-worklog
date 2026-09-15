import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { LocalSupervisorClient } from 'model-worklog-sdk';

const runFile = promisify(execFile);
const STEP_DELAY_MS = 2_500;

async function pause() {
	await delay(STEP_DELAY_MS);
}

async function simulatedProviderResponse() {
	return {
		object: 'response',
		id: 'resp_live_demo_001',
		model: 'gpt-5.6-terra',
		usage: {
			input_tokens: 48,
			output_tokens: 24,
			output_tokens_details: { reasoning_tokens: 8 },
			total_tokens: 72,
		},
	};
}

async function main() {
	const client = await LocalSupervisorClient.fromLocalEnvironment();
	const session = await client.startSession({
		workspacePath: process.cwd(),
		actor: 'live-sdk-demo',
		title: 'Review Model Logger README',
		runMode: 'observe',
	});

	process.stdout.write(`Live Model Logger session: ${session.record.sessionId}\n`);
	process.stdout.write('Open Model Logger > Live Activity in VS Code, expand the log, and select View Log.\n');
	process.stdout.write('The demo emits a new visible event about every 2.5 seconds.\n');

	try {
		await pause();
		await session.userMessage('Review the README and report the package name.');

		await pause();
		await session.plan('Read the project README, check the Node runtime, then report the visible findings.', [
			'Read README.md',
			'Run node --version',
			'Summarize the observed result',
		]);

		await pause();
		await session.reasoningSummary('The README and Node version are enough for this small review without changing workspace files.');

		await pause();
		const source = await session.runTool({
			tool: 'read_file',
			arguments: { path: 'README.md' },
			correlationId: 'live_read_readme',
		}, async () => readFile('README.md', 'utf8'), {
			serializeResult: (contents) => ({ path: 'README.md', charactersRead: contents.length }),
		});
		await session.fileRead({ path: 'README.md', tool: 'read_file', correlationId: 'live_read_readme' });

		await pause();
		await session.commandStarted({ executable: process.execPath, args: ['--version'], correlationId: 'live_node_version' });
		const { stdout } = await runFile(process.execPath, ['--version']);
		await session.commandCompleted({ executable: process.execPath, args: ['--version'], exitCode: 0, correlationId: 'live_node_version' });

		await pause();
		const packageName = /#\s+([^\n]+)/.exec(source)?.[1] ?? 'Model Logger';
		await session.summary(`Reviewed README.md (${source.length.toLocaleString()} characters). The package is ${packageName}; Node reports ${stdout.trim()}.`);

		await pause();
		await session.reportProviderUsage('openai', await simulatedProviderResponse());
		await session.testCompleted({ name: 'live-demo-readme-check', success: source.length > 0, durationMs: STEP_DELAY_MS * 6 });
		await session.complete();
		process.stdout.write(`Live demo completed: ${session.record.sessionId}\n`);
	} catch (error) {
		await session.complete('failed').catch(() => undefined);
		throw error;
	}
}

main().catch((error) => {
	process.stderr.write(`Live demo failed: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});