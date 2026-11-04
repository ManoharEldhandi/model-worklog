import { spawnAgentCli } from 'model-worklog-sdk';
import { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LogSynthesisResultSchema, type LogConversationMessage, type LogQueryResponse, type LogSynthesisResult } from 'model-worklog-schema';

import type { LogAnswerGenerator } from '../domain/logQuery';
import { COPILOT_LOG_ANSWER_INSTRUCTIONS, logAnswerContext } from '../domain/logPrompt';

export type SpawnLogAnswer = (command: string, argumentsValue: readonly string[], options: SpawnOptionsWithoutStdio) => ChildProcessWithoutNullStreams;

export interface CopilotLogAnswerOptions {
	readonly model?: string;
	readonly spawn?: SpawnLogAnswer;
}

function readAnswer(child: ChildProcessWithoutNullStreams, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let bytes = 0;
		let failure: unknown;
		let interrupt: ReturnType<typeof setTimeout> | undefined;
		const stop = (error: unknown): void => {
			failure ??= error;
			child.kill('SIGTERM');
			interrupt ??= setTimeout(() => { child.kill('SIGKILL'); }, 3_000);
			interrupt.unref();
		};
		const abort = (): void => stop(signal.reason ?? new Error('Log answer cancelled.'));
		child.stdout.on('data', (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			bytes += buffer.length;
			if (bytes > 65_536) { stop(new Error('Copilot log answer exceeded the output limit.')); return; }
			chunks.push(buffer);
		});
		child.stderr.resume();
		child.stdin.on('error', () => stop(new Error('Copilot could not receive the evidence payload.')));
		child.once('error', () => { failure = new Error('Copilot log answers could not start.'); });
		child.once('close', (code) => {
			if (interrupt !== undefined) { clearTimeout(interrupt); }
			signal.removeEventListener('abort', abort);
			if (failure !== undefined) { reject(failure); return; }
			if (code !== 0) { reject(new Error('Copilot log answer failed; check local Copilot authentication and CLI compatibility.')); return; }
			try { resolve(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)).trim()); }
			catch { reject(new Error('Copilot returned invalid answer encoding.')); }
		});
		signal.addEventListener('abort', abort, { once: true });
		if (signal.aborted) { abort(); return; }
		child.stdin.end();
	});
}

export class CopilotLogAnswerGenerator implements LogAnswerGenerator {
	readonly provider = 'github-copilot';
	readonly model: string | undefined;
	private readonly launch: SpawnLogAnswer;
	private active = 0;
	private optionalFlags: readonly string[] | undefined;

	constructor(options: CopilotLogAnswerOptions = {}) {
		if (options.model !== undefined && (options.model.trim() === '' || options.model.length > 128)) { throw new Error('Invalid Copilot log-answer model.'); }
		this.model = options.model;
		this.launch = options.spawn ?? ((command, argumentsValue, configuration) => spawnAgentCli('copilot', argumentsValue, { ...configuration, stdio: 'pipe' }) as ChildProcessWithoutNullStreams);
	}

	async generate(question: string, evidence: Readonly<LogQueryResponse>, signal: AbortSignal, history: readonly Readonly<LogConversationMessage>[] = []): Promise<LogSynthesisResult> {
		signal.throwIfAborted();
		if (this.active >= 2) { throw new Error('Copilot log answers are busy.'); }
		const input = logAnswerContext(question, evidence, history);
		if (Buffer.byteLength(input) > 128 * 1024) { throw new Error('The Copilot evidence payload exceeds the safety limit.'); }
		this.active += 1;
		let directory: string | undefined;
		try {
			const optionalFlags = await this.compatibleFlags(signal);
			directory = await mkdtemp(join(tmpdir(), 'mw-log-answer-'));
			signal.throwIfAborted();
			const child = this.launch('copilot', [
				'--prompt', `${COPILOT_LOG_ANSWER_INSTRUCTIONS}\nEVIDENCE_JSON:\n${input}`,
				'--silent', '--stream', 'off', '--output-format', 'text', '--available-tools',
				'--deny-tool', 'shell', '--deny-tool', 'write', '--deny-tool', 'url', '--disallow-temp-dir', '--disable-builtin-mcps', '--no-custom-instructions',
				'--no-ask-user', '--no-bash-env', ...optionalFlags, '--no-color',
				'--log-level', 'none', '--log-dir', join(directory, 'logs'),
				...(this.model === undefined ? [] : ['--model', this.model]),
			], { cwd: directory, windowsHide: true, env: { ...process.env, COPILOT_ALLOW_ALL: 'false' } });
			const answer = await readAnswer(child, signal);
			const sourceIds = [...new Set([...answer.matchAll(/\[((?:S[1-9][0-9]*|A1))\]/g)].map((match) => match[1]!))];
			if (evidence.totals.spans > 0 && sourceIds.length === 0) { throw new Error('Copilot returned an answer without evidence citations.'); }
			return LogSynthesisResultSchema.parse({ answer, sourceIds });
		} finally {
			this.active -= 1;
			if (directory !== undefined) { await rm(directory, { recursive: true, force: true }); }
		}
	}

	private async compatibleFlags(signal: AbortSignal): Promise<readonly string[]> {
		if (this.optionalFlags !== undefined) { return this.optionalFlags; }
		const child = this.launch('copilot', ['--help'], { windowsHide: true, env: { ...process.env, COPILOT_ALLOW_ALL: 'false' } });
		const help = await readAnswer(child, AbortSignal.any([signal, AbortSignal.timeout(5_000)]));
		const required = ['--prompt', '--silent', '--stream', '--output-format', '--available-tools', '--deny-tool', '--disallow-temp-dir',
			'--disable-builtin-mcps', '--no-custom-instructions', '--no-ask-user', '--no-bash-env', '--no-color', '--log-level', '--log-dir'];
		if (required.some((flag) => !help.includes(flag))) { throw new Error('The installed Copilot CLI lacks required restricted log-answer capabilities.'); }
		const history = help.includes('--sync-session') ? '--sync-session=off' : help.includes('--no-remote-export') ? '--no-remote-export' : undefined;
		if (history === undefined) { throw new Error('The installed Copilot CLI cannot disable account history syncing.'); }
		this.optionalFlags = Object.freeze([history, ...(help.includes('--disable-client-telemetry') ? ['--disable-client-telemetry'] : [])]);
		return this.optionalFlags;
	}
}
