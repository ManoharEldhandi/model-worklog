import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SUPERVISOR_URL = 'http://127.0.0.1:43199';
const USAGE_ATTRIBUTES = [
	'gen_ai.provider.name',
	'gen_ai.response.model',
	'gen_ai.request.model',
	'gen_ai.usage.input_tokens',
	'gen_ai.usage.output_tokens',
	'gen_ai.usage.cache_read.input_tokens',
	'gen_ai.usage.reasoning.output_tokens',
] as const;

type TerminalState = 'completed' | 'failed' | 'interrupted';

function localHome(): string {
	return process.env.MODEL_WORKLOG_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '', '.model-worklog');
}

function loopbackUrl(raw: string): URL | undefined {
	try {
		const url = new URL(raw);
		const host = url.hostname.replace(/^\[(.+)\]$/, '$1');
		return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(host) ? url : undefined;
	} catch {
		return undefined;
	}
}

function vendorSessionId(): string {
	const value = process.argv[2];
	if (value === undefined || !/^[a-zA-Z0-9_-]{1,128}$/.test(value)) {
		throw new Error('Expected a Copilot session ID.');
	}
	return value;
}

function terminalState(code: number | null, signal: NodeJS.Signals | null, interrupted: boolean): TerminalState {
	if (interrupted || signal !== null || code === 130) {
		return 'interrupted';
	}
	return code === 0 ? 'completed' : 'failed';
}

function minimalTelemetry(content: string): string {
	const spans: string[] = [];
	for (const line of content.split('\n')) {
		if (line.trim() === '') {
			continue;
		}
		try {
			const value = JSON.parse(line) as { type?: unknown; name?: unknown; attributes?: unknown };
			if (value.type !== 'span' || typeof value.name !== 'string' || !value.name.startsWith('chat ') || typeof value.attributes !== 'object' || value.attributes === null || Array.isArray(value.attributes)) {
				continue;
			}
			const attributes = value.attributes as Record<string, unknown>;
			const selected = Object.fromEntries(USAGE_ATTRIBUTES.flatMap((key) => attributes[key] === undefined ? [] : [[key, attributes[key]]]));
			spans.push(JSON.stringify({ type: 'span', name: value.name, attributes: selected }));
		} catch {
			continue;
		}
	}
	return spans.join('\n');
}

async function readTelemetry(path: string): Promise<string> {
	try {
		return minimalTelemetry(await readFile(path, 'utf8'));
	} catch {
		return '';
	}
}

async function reportUsage(sessionId: string, telemetry: string, state: TerminalState): Promise<void> {
	const supervisorUrl = loopbackUrl(process.env.MODEL_WORKLOG_SUPERVISOR_URL ?? DEFAULT_SUPERVISOR_URL);
	if (supervisorUrl === undefined) {
		return;
	}
	const token = (await readFile(join(localHome(), 'auth-token'), 'utf8')).trim();
	if (token === '') {
		return;
	}
	await fetch(new URL('/v1/copilot-interactive-usage', supervisorUrl), {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-model-worklog-token': token },
		body: JSON.stringify({ vendorSessionId: sessionId, telemetry, state }),
		signal: AbortSignal.timeout(5_000),
	});
}

async function run(): Promise<void> {
	const sessionId = vendorSessionId();
	const telemetryDirectory = await mkdtemp(join(tmpdir(), 'model-worklog-copilot-interactive-'));
	const telemetryPath = join(telemetryDirectory, 'telemetry.jsonl');
	let interrupted = false;
	process.on('SIGINT', () => { interrupted = true; });
	process.on('SIGTERM', () => { interrupted = true; });
	try {
		const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
			const child = spawn('copilot', ['--session-id', sessionId], {
				cwd: process.cwd(),
				env: {
					...process.env,
					COPILOT_OTEL_FILE_EXPORTER_PATH: telemetryPath,
					COPILOT_OTEL_EXPORTER_TYPE: 'file',
					OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT: 'false',
				},
				stdio: 'inherit',
				windowsHide: true,
			});
			child.once('error', () => resolve({ code: 1, signal: null }));
			child.once('close', (code, signal) => resolve({ code, signal }));
		});
		const state = terminalState(result.code, result.signal, interrupted);
		await reportUsage(sessionId, await readTelemetry(telemetryPath), state).catch(() => undefined);
		process.exitCode = result.code ?? 1;
	} finally {
		await rm(telemetryDirectory, { recursive: true, force: true });
	}
}

void run().catch(() => {
	process.exitCode = 1;
});