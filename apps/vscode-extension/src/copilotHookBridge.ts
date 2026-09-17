import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_SUPERVISOR_URL = 'http://127.0.0.1:43199';

function localHome(): string {
	return process.env.MODEL_WORKLOG_HOME ?? join(homedir(), '.model-worklog');
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

async function input(): Promise<unknown> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

async function forward(): Promise<void> {
	if (process.env.MODEL_WORKLOG_HOOK_BRIDGE !== '1') {
		return;
	}
	const body = await input();
	const url = loopbackUrl(process.env.MODEL_WORKLOG_SUPERVISOR_URL ?? DEFAULT_SUPERVISOR_URL);
	if (url === undefined) {
		return;
	}
	const token = (await readFile(join(localHome(), 'auth-token'), 'utf8')).trim();
	if (token === '') {
		return;
	}
	await fetch(new URL('/v1/copilot-hook-events', url), {
		method: 'POST',
		headers: { 'content-type': 'application/json', 'x-model-worklog-token': token },
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(1_500),
	});
}

void forward()
	.catch(() => undefined)
	.finally(() => {
		// A neutral response preserves normal Copilot hook behavior, including preToolUse.
		process.stdout.write('{}\n');
	});