import assert from 'node:assert/strict';
import test from 'node:test';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { CodexLogAnswerGenerator } from './codexLogAnswers.mjs';

test('log answers default to the small model independently of the workspace model', () => {
	assert.equal(new CodexLogAnswerGenerator().model, 'gpt-5.6-luna');
});

test('Codex answers use the selected model and only supplied evidence, with cleanup', async () => {
	let configuration; let argumentsValue; let input = '';
	const generator = new CodexLogAnswerGenerator({ model: 'gpt-5.6-terra', spawn(args, options) {
		argumentsValue = args; configuration = options;
		const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
		child.stdin.on('data', (chunk) => { input += chunk; });
		child.stdin.on('finish', async () => {
			await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify({ answer: 'The captured test rejected a negative quantity. [S1]', sourceIds: ['S1'] }));
			child.emit('close', 0);
		});
		return child;
	} });
	const result = await generator.generate('What failed?', { scope: {}, totals: { spans: 1 }, tools: [], overview: {}, retrieval: {}, limitations: [], evidence: [{ id: 'S1', excerpt: 'negative quantity', excerptTruncated: false }] }, new AbortController().signal, []);
	assert.match(result.answer, /negative quantity/);
	assert.equal(argumentsValue[argumentsValue.indexOf('--model') + 1], 'gpt-5.6-terra');
	for (const flag of ['--ignore-user-config', '--ignore-rules', '--ephemeral']) { assert.ok(argumentsValue.includes(flag)); }
	assert.ok(argumentsValue.includes('features.shell_tool=false'));
	assert.ok(argumentsValue.includes('features.unified_exec=false'));
	assert.ok(argumentsValue.includes('web_search="disabled"'));
	assert.ok(argumentsValue.includes('features.hooks=false'));
	assert.match(input, /negative quantity/);
	assert.equal(configuration.shell, false);
	await assert.rejects(import('node:fs/promises').then(({ access }) => access(configuration.cwd)));
});

test('Codex answers cancel their process instead of leaving it running', async () => {
	const controller = new AbortController(); let killed = false;
	const generator = new CodexLogAnswerGenerator({ spawn() {
		const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { killed = true; queueMicrotask(() => child.emit('close', null)); } });
		child.stdin.on('finish', () => controller.abort(new Error('cancelled')));
		return child;
	} });
	await assert.rejects(generator.generate('Why?', { scope: {}, totals: {}, tools: [], overview: {}, retrieval: {}, limitations: [], evidence: [] }, controller.signal), /cancelled/);
	assert.equal(killed, true);
});
