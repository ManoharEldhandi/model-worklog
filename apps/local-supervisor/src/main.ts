#!/usr/bin/env node
import { LOOPBACK_HOSTS, startSupervisor } from './server';
import { DEFAULT_SUPERVISOR_PORT, SUPERVISOR_VERSION } from './version';
import type { LogAnswerGenerator } from './traces/domain/logQuery';
import { CopilotLogAnswerGenerator } from './traces/infrastructure/copilotLogAnswerGenerator';
import { OpenAiLogAnswerGenerator } from './traces/infrastructure/logAnswerGenerator';

function configuredAnswerGenerator(): LogAnswerGenerator | undefined {
	const provider = process.env.MODEL_WORKLOG_RAG_PROVIDER;
	const endpoint = process.env.MODEL_WORKLOG_RAG_URL;
	const model = process.env.MODEL_WORKLOG_RAG_MODEL;
	const apiKey = process.env.MODEL_WORKLOG_RAG_API_KEY;
	if (provider === undefined && endpoint === undefined && model === undefined && apiKey === undefined) { return undefined; }
	if (provider === 'copilot') {
		if (endpoint !== undefined || apiKey !== undefined) { throw new Error('Copilot log answers use local Copilot authentication; do not combine them with OpenAI-compatible endpoint credentials.'); }
		return new CopilotLogAnswerGenerator({ model });
	}
	if (provider !== undefined && provider !== 'openai-compatible') { throw new Error('MODEL_WORKLOG_RAG_PROVIDER must be copilot or openai-compatible.'); }
	if (endpoint === undefined || model === undefined) { throw new Error('Set both MODEL_WORKLOG_RAG_URL and MODEL_WORKLOG_RAG_MODEL to enable optional log answer synthesis.'); }
	return new OpenAiLogAnswerGenerator({ endpoint, model, apiKey });
}

function resolvePort(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === '') {
		return DEFAULT_SUPERVISOR_PORT;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
		throw new Error(`invalid MODEL_WORKLOG_SUPERVISOR_PORT: ${raw}`);
	}
	return parsed;
}

function resolveHost(raw: string | undefined): string {
	const host = raw ?? '127.0.0.1';
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(`invalid MODEL_WORKLOG_SUPERVISOR_HOST: ${host}`);
	}
	return host;
}

async function main(): Promise<void> {
	const port = resolvePort(process.env.MODEL_WORKLOG_SUPERVISOR_PORT);
	const running = await startSupervisor({
		version: SUPERVISOR_VERSION,
		host: resolveHost(process.env.MODEL_WORKLOG_SUPERVISOR_HOST),
		port,
		shutdownWhenNoExtensionClients: process.env.MODEL_WORKLOG_SHUTDOWN_WHEN_IDLE === '1',
		logAnswerGenerator: configuredAnswerGenerator(),
	});
	process.stderr.write(`model-worklog supervisor ${SUPERVISOR_VERSION} listening on ${running.url} (instance ${running.instanceId})\n`);

	let closing = false;
	const shutdown = (): void => {
		if (closing) {
			return;
		}
		closing = true;
		running
			.close()
			.then(() => process.exit(0))
			.catch(() => process.exit(1));
	};
	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`supervisor failed to start: ${message}\n`);
	process.exit(1);
});
