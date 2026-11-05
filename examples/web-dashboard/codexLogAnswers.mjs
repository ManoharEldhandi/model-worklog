import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnAgentCli } from 'model-worklog-sdk';
import { LogSynthesisResultSchema } from 'model-worklog-schema';
import { LOG_ANSWER_INSTRUCTIONS, logAnswerContext } from '../../apps/local-supervisor/dist/traces/domain/logPrompt.js';

// The answer process receives evidence only; workspace execution is a separate session.
export class CodexLogAnswerGenerator {
	provider = 'codex-cli';
	constructor({ model = 'gpt-5.6-terra', spawn = (args, options) => spawnAgentCli('codex', args, options) } = {}) {
		if (!model.trim() || model.length > 128) { throw new Error('Invalid Codex demo model.'); }
		this.model = model; this.spawn = spawn; this.active = 0;
	}
	async generate(question, evidence, signal, history = []) {
		signal.throwIfAborted();
		if (this.active >= 2) { throw new Error('Codex answers are busy.'); }
		this.active++;
		let directory;
		try {
			directory = await mkdtemp(join(tmpdir(), 'model-worklog-codex-answer-'));
			const output = join(directory, 'answer.json'); const schema = join(directory, 'schema.json');
			await writeFile(schema, JSON.stringify({ type: 'object', properties: { answer: { type: 'string' }, sourceIds: { type: 'array', items: { type: 'string' } } }, required: ['answer', 'sourceIds'], additionalProperties: false }));
			const input = `${LOG_ANSWER_INSTRUCTIONS}\nEVIDENCE_JSON:\n${logAnswerContext(question, evidence, history)}`;
			if (Buffer.byteLength(input) > 128 * 1024) { throw new Error('Evidence exceeds the answer input limit.'); }
			signal.throwIfAborted();
			const flags = ['features.shell_tool=false', 'features.unified_exec=false', 'features.apps=false', 'features.browser_use=false', 'features.computer_use=false', 'features.multi_agent=false', 'features.hooks=false', 'features.code_mode=false', 'features.code_mode_host=false', 'web_search="disabled"', 'project_doc_max_bytes=0', 'model_reasoning_effort="low"'];
			const child = this.spawn(['exec', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', this.model,
				...flags.flatMap((flag) => ['--config', flag]), '--output-schema', schema, '--output-last-message', output, '-'],
			{ cwd: directory, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
			await new Promise((resolve, reject) => {
				let failure; let timer; let bytes = 0;
				const stop = (error) => { failure ??= error; child.kill('SIGTERM'); timer ??= setTimeout(() => child.kill('SIGKILL'), 3000); timer.unref(); };
				const abort = () => stop(signal.reason ?? new Error('Codex answer cancelled.'));
				for (const stream of [child.stdout, child.stderr]) { stream.on('data', (chunk) => { bytes += chunk.length; if (bytes > 1024 * 1024) { stop(new Error('Codex answer output exceeded its limit.')); } }); }
				child.stdin.on('error', () => stop(new Error('Codex could not receive the evidence.')));
				child.once('error', () => { failure = new Error('Codex answers could not start. Check the installed CLI.'); });
				child.once('close', (code) => { clearTimeout(timer); signal.removeEventListener('abort', abort); if (failure) { reject(failure); } else if (code !== 0) { reject(new Error('Codex answer failed. Check codex login and the configured demo model.')); } else { resolve(); } });
				signal.addEventListener('abort', abort, { once: true });
				if (signal.aborted) { abort(); } else { child.stdin.end(input); }
			});
			if ((await stat(output)).size > 65_536) { throw new Error('Codex answer exceeded its limit.'); }
			return LogSynthesisResultSchema.parse(JSON.parse(await readFile(output, 'utf8')));
		} finally { this.active--; if (directory) { await rm(directory, { recursive: true, force: true }); } }
	}
}
