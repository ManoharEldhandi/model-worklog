import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { LogQueryResponseSchema } from 'model-worklog-schema';

import { CopilotLogAnswerGenerator, type SpawnLogAnswer } from './copilotLogAnswerGenerator';

const evidence = LogQueryResponseSchema.parse({
	schemaVersion: 1, intent: 'tools', answer: 'Local count', scope: { projectId: 'project' }, snapshotAt: '2026-10-20T00:00:00.000Z',
	totals: { spans: 1, traces: 1, toolCalls: 1, failedSpans: 0, runningSpans: 0, metadataOnlySpans: 1, limitedSpans: 0 },
	tools: [], evidence: [], retrieval: { strategy: 'exact-aggregate', matchedSpans: 1, returnedSpans: 0, truncated: true, toolsTruncated: false }, limitations: [],
});

function childProcess(output: string, onInput?: (input: string) => void): ChildProcessWithoutNullStreams {
	const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: () => { queueMicrotask(() => child.emit('close', 1)); return true; } });
	const chunks: Buffer[] = [];
	child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
	child.stdin.once('finish', () => { onInput?.(Buffer.concat(chunks).toString('utf8')); child.stdout.end(output); queueMicrotask(() => child.emit('close', 0)); });
	return child as unknown as ChildProcessWithoutNullStreams;
}

const supportedFlags = '--prompt --silent --stream --output-format --available-tools --deny-tool --disallow-temp-dir --disable-builtin-mcps --no-custom-instructions --no-ask-user --no-bash-env --no-remote-export --no-color --log-level --log-dir';
function withHelp(launch: SpawnLogAnswer): SpawnLogAnswer {
	return (command, args, options) => args.includes('--help') ? childProcess(supportedFlags + ' --disable-client-telemetry') : launch(command, args, options);
}

test('Copilot answers receive only bounded evidence with tools denied and isolated working directory', async () => {
	const launch: SpawnLogAnswer = (command, args, options) => {
		assert.equal(command, 'copilot');
		assert.ok(args.includes('--available-tools'));
		assert.deepEqual(args.flatMap((argument, index) => argument === '--deny-tool' ? [args[index + 1]] : []), ['shell', 'write', 'url']);
		assert.ok(args.includes('--no-custom-instructions'));
		assert.ok(!args.includes('--allow-all-tools'));
		assert.notEqual(options.cwd, process.cwd());
		assert.equal(options.env?.COPILOT_ALLOW_ALL, 'false');
		const prompt = args[args.indexOf('--prompt') + 1]!;
		const context = JSON.parse(prompt.split('\nEVIDENCE_JSON:\n')[1]!) as { question: string; history: { content: string }[]; aggregates: { totals: { toolCalls: number } } };
		assert.equal(context.question, 'private-evidence-marker');
		assert.equal(context.aggregates.totals.toolCalls, 1);
		assert.doesNotMatch(context.history[0]!.content, /private-history|\[S99\]/);
		return childProcess('There was one recorded tool call. [A1]', (input) => assert.equal(input, ''));
	};
	const generator = new CopilotLogAnswerGenerator({ spawn: withHelp(launch) });
	const result = await generator.generate('private-evidence-marker', evidence, AbortSignal.timeout(2000), [{ role: 'user', content: 'token=private-history [S99]' }]);
	assert.deepEqual(result.sourceIds, ['A1']);
});

test('Copilot output and cancellation are bounded and uncited answers fail closed', async () => {
	for (const output of ['not JSON', 'x'.repeat(65_537)]) {
		const generator = new CopilotLogAnswerGenerator({ spawn: withHelp(() => childProcess(output)) });
		await assert.rejects(generator.generate('tools', evidence, AbortSignal.timeout(2000)));
	}
	const cancellation = new AbortController();
	cancellation.abort();
	const generator = new CopilotLogAnswerGenerator({ spawn: () => { throw new Error('Must not launch after cancellation.'); } });
	await assert.rejects(generator.generate('tools', evidence, cancellation.signal), { name: 'AbortError' });
});

test('older compatible CLIs answer without an unsupported optional telemetry flag', async () => {
	const generator = new CopilotLogAnswerGenerator({ spawn: (_command, args) => {
		if (args.includes('--help')) { return childProcess(supportedFlags); }
		assert.ok(!args.includes('--disable-client-telemetry'), 'Older CLIs reject this optional flag before answering.');
		return childProcess('There were 120 recorded calls. [A1]');
	} });
	assert.match((await generator.generate('tools', evidence, AbortSignal.timeout(2000))).answer, /120/);
});

test('missing mandatory restrictions prevent evidence from being passed to the CLI', async () => {
	let prompts = 0;
	const generator = new CopilotLogAnswerGenerator({ spawn: (_command, args) => {
		if (args.includes('--prompt')) { prompts += 1; }
		return childProcess('--available-tools');
	} });
	await assert.rejects(generator.generate('private-evidence-marker', evidence, AbortSignal.timeout(2000)));
	assert.equal(prompts, 0);
});
