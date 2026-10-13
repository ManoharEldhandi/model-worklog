import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalModelLogger } from 'model-worklog-sdk';
import { createTraceCredential, startSupervisor } from 'model-worklog-supervisor';

const PROJECT_ID = 'web-demo';
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_REQUEST_BYTES = 16_384;
const SAMPLE_WORKSPACE_FILES = ['README.md', 'src/inventory.ts', 'src/pricing.ts'];
const COPILOT_MAX_DURATION_MS = 120_000;
const STATIC_FILES = new Map([
	['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
	['/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
	['/styles.css', { file: 'styles.css', contentType: 'text/css; charset=utf-8' }],
]);

function pause(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function responseBody(response) {
	return JSON.stringify(response);
}

function sendJson(response, statusCode, body) {
	const payload = responseBody(body);
	response.writeHead(statusCode, {
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(payload),
		'content-security-policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'",
		'content-type': 'application/json; charset=utf-8',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
	});
	response.end(payload);
}

function sendDownload(response, filename, body) {
	const payload = responseBody(body);
	response.writeHead(200, {
		'cache-control': 'no-store',
		'content-disposition': `attachment; filename="${filename}"`,
		'content-length': Buffer.byteLength(payload),
		'content-security-policy': "default-src 'none'",
		'content-type': 'application/json; charset=utf-8',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
	});
	response.end(payload);
}

function sendError(response, statusCode, message) {
	sendJson(response, statusCode, { error: { message } });
}

async function readRequestBody(request) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_REQUEST_BYTES) {
			throw new Error('Request body is too large.');
		}
		chunks.push(buffer);
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function addEvent(run, message, detail) {
	run.events.push({
		at: new Date().toISOString(),
		detail,
		id: randomUUID(),
		message,
	});
}

function readableDuration(startedAt, endedAt) {
	if (endedAt === undefined) {
		return undefined;
	}
	return Math.max(0, Date.parse(endedAt) - Date.parse(startedAt));
}

function summarizeTrace(payload) {
	const spans = Array.isArray(payload?.spans) ? payload.spans : [];
	return {
		spanCount: spans.length,
		spans: spans.map(({ evidenceGrade, span }) => ({
			durationMs: readableDuration(span.startedAt, span.endedAt),
			evidenceGrade,
			kind: span.kind,
			name: span.name,
			state: span.state,
		})),
	};
}

function fallbackResponse(message) {
	const words = message.trim().split(/\s+/).filter(Boolean);
	const focus = words.slice(0, 8).join(' ') || 'your request';
	return {
		content: `This is the built-in demo response for "${focus}". Configure an OpenAI-compatible endpoint to send this chat to a live model.`,
		mode: 'offline-demo',
		model: 'built-in-demo',
		provider: 'local',
	};
}

function providerResponse(payload, provider) {
	const choice = payload?.choices?.[0]?.message?.content;
	const content = typeof choice === 'string' ? choice.trim() : '';
	if (content === '') {
		throw new Error('The configured provider returned no assistant message.');
	}
	const usage = payload?.usage;
	const inputTokens = Number.isSafeInteger(usage?.prompt_tokens) ? usage.prompt_tokens : undefined;
	const outputTokens = Number.isSafeInteger(usage?.completion_tokens) ? usage.completion_tokens : undefined;
	const totalTokens = Number.isSafeInteger(usage?.total_tokens) ? usage.total_tokens : undefined;
	return {
		content,
		mode: 'live-provider',
		model: typeof payload?.model === 'string' ? payload.model : provider.model,
		provider: 'openai-compatible',
		usage: totalTokens === undefined && inputTokens === undefined && outputTokens === undefined
			? undefined
			: {
				inputTokens,
				model: typeof payload?.model === 'string' ? payload.model : provider.model,
				outputTokens,
				provider: 'openai-compatible',
				source: 'provider-reported',
				totalTokens,
			},
	};
}

async function requestModel(message, provider) {
	if (provider.kind === 'offline-demo') {
		await pause(180);
		return fallbackResponse(message);
	}
	if (provider.endpoint === undefined) {
		throw new Error('An OpenAI-compatible endpoint is required for the selected provider.');
	}
	const response = await fetch(provider.endpoint, {
		body: JSON.stringify({
			messages: [{ content: 'Answer clearly and concisely.', role: 'system' }, { content: message, role: 'user' }],
			model: provider.model,
			stream: false,
		}),
		headers: {
			'content-type': 'application/json',
			...(provider.apiKey === undefined ? {} : { authorization: `Bearer ${provider.apiKey}` }),
		},
		method: 'POST',
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) {
		throw new Error(`The configured provider returned HTTP ${response.status}.`);
	}
	return providerResponse(await response.json(), provider);
}

async function supervisorRequest(collector, token, pathname, method, body) {
	const response = await fetch(new URL(pathname, collector.url), {
		method,
		headers: {
			'x-model-worklog-token': token,
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
	const payload = await response.json();
	if (!response.ok) {
		throw new Error(payload?.error?.message ?? `Supervisor returned HTTP ${response.status}.`);
	}
	return payload;
}

function value(record, key) {
	return record !== null && typeof record === 'object' && !Array.isArray(record) ? record[key] : undefined;
}

function text(value) {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function usageFromSession(session) {
	const usage = value(session, 'tokenUsage');
	if (value(usage, 'status') !== 'reported') {
		return undefined;
	}
	const source = text(value(usage, 'source'));
	const sourceIsSpanCompatible = source === 'provider-reported' || source === 'computed-from-provider-fields' || source === 'adapter-reported';
	return {
		cacheReadTokens: value(usage, 'cacheReadTokens'),
		cacheWriteTokens: value(usage, 'cacheWriteTokens'),
		inputTokens: value(usage, 'inputTokens'),
		models: Array.isArray(value(usage, 'models')) ? value(usage, 'models') : [],
		outputTokens: value(usage, 'outputTokens'),
		providers: Array.isArray(value(usage, 'providers')) ? value(usage, 'providers') : [],
		reasoningTokens: value(usage, 'reasoningTokens'),
		...(sourceIsSpanCompatible ? { source } : {}),
		totalTokens: value(usage, 'totalTokens'),
	};
}

function usageDetail(usage) {
	if (usage === undefined) {
		return 'Not reported by the provider.';
	}
	return [
		`input=${usage.inputTokens}`, `output=${usage.outputTokens}`,
		`cache-read=${usage.cacheReadTokens}`, `cache-write=${usage.cacheWriteTokens}`,
		`reasoning=${usage.reasoningTokens}`, `total=${usage.totalTokens}`,
	].join(' | ');
}

function describeCopilotEvent(run, event, recordTraceEvent) {
	const payload = event?.payload;
	if (event?.kind === 'file.read') {
		const path = text(value(payload, 'path')) ?? 'Sample workspace file';
		addEvent(run, 'Copilot read workspace file', path);
		recordTraceEvent('copilot.file.read', { path });
		return;
	}
	if (event?.kind === 'tool.called') {
		const tool = text(value(payload, 'tool')) ?? 'Tool';
		addEvent(run, 'Copilot started tool', tool);
		recordTraceEvent('copilot.tool.started', { tool });
		return;
	}
	if (event?.kind === 'tool.completed') {
		const tool = text(value(payload, 'tool')) ?? 'Tool';
		addEvent(run, 'Copilot completed tool', tool);
		recordTraceEvent('copilot.tool.completed', { tool });
		return;
	}
	if (event?.kind === 'agent.message') {
		const message = text(value(payload, 'text'));
		if (text(value(payload, 'role')) === 'assistant' && message !== undefined) {
			run.copilotMessages.push(message);
			addEvent(run, 'Copilot sent visible response', message);
			recordTraceEvent('copilot.response.received', { characters: message.length });
		}
		return;
	}
	if (event?.kind === 'agent.summary' && event?.evidenceGrade === 'unknown') {
		addEvent(run, 'Copilot reasoning withheld', 'Raw reasoning is not captured.');
		recordTraceEvent('copilot.reasoning.withheld');
		return;
	}
	if (event?.kind === 'adapter.lifecycle') {
		const phase = text(value(payload, 'phase'));
		if (phase !== undefined) {
			addEvent(run, 'Copilot lifecycle', phase);
			recordTraceEvent('copilot.lifecycle', { phase });
		}
	}
}

function copilotTask(message) {
	return [
		'You are reviewing the current sample workspace in read-only mode.',
		'Do not create, edit, rename, or delete files. Do not run commands that modify the workspace.',
		'Read the files needed to answer the user request, then give a concise response with filenames.',
		`User request: ${message}`,
	].join('\n\n');
}

async function requestCopilotReview(run, context, recordTraceEvent) {
	addEvent(run, 'Starting Copilot workspace review', 'Isolated workspace copy');
	recordTraceEvent('copilot.review.started', { workspace: 'isolated-copy' });
	const started = await supervisorRequest(context.collector, context.collectorToken, '/v1/copilot-sessions', 'POST', {
		maxDurationMs: COPILOT_MAX_DURATION_MS,
		task: copilotTask(run.message),
		workspacePath: context.workspacePath,
	});
	const sessionId = text(value(value(started, 'session'), 'sessionId'));
	if (sessionId === undefined) {
		throw new Error('Supervisor did not return a Copilot session ID.');
	}
	run.copilotSessionId = sessionId;
	let afterSequence = 0;
	let terminal = false;
	while (!terminal) {
		const snapshot = await supervisorRequest(context.collector, context.collectorToken, `/v1/sessions/${encodeURIComponent(sessionId)}/events?afterSequence=${afterSequence}`, 'GET');
		const events = Array.isArray(value(snapshot, 'events')) ? value(snapshot, 'events') : [];
		for (const event of events) {
			const sequence = value(event, 'sequence');
			if (typeof sequence === 'number') {
				afterSequence = Math.max(afterSequence, sequence);
			}
			describeCopilotEvent(run, event, recordTraceEvent);
		}
		terminal = value(snapshot, 'terminal') === true;
		if (!terminal) {
			await pause(160);
		}
	}
	const completed = await supervisorRequest(context.collector, context.collectorToken, `/v1/sessions/${encodeURIComponent(sessionId)}`, 'GET');
	const session = value(completed, 'session');
	const state = text(value(session, 'state'));
	if (state !== 'completed') {
		throw new Error(`Copilot session ended with state ${state ?? 'unknown'}. Run copilot login if authentication is required.`);
	}
	const content = run.copilotMessages.join('\n\n');
	return {
		content: content === '' ? 'Copilot completed without returning a visible assistant message.' : content,
		mode: 'copilot-cli',
		model: context.provider.model,
		provider: 'github-copilot',
		usage: usageFromSession(session),
	};
}

async function loadTrace(collector, readerToken, traceId) {
	const response = await fetch(new URL(`/v2/traces/${traceId}?projectId=${PROJECT_ID}`, collector.url), {
		headers: { 'x-model-worklog-token': readerToken },
	});
	if (!response.ok) {
		throw new Error(`Trace readback returned HTTP ${response.status}.`);
	}
	return summarizeTrace(await response.json());
}

async function executeRun(run, context) {
	const logger = await createLocalModelLogger({
		endpoint: context.collector.url,
		privacy: { mode: 'redacted-content' },
		projectId: PROJECT_ID,
		serviceName: 'web-dashboard',
		token: context.writerToken,
	});
	let failed;
	try {
		await logger.trace({
			attributes: { 'demo.surface': 'browser' },
			input: { message: run.message },
			kind: 'agent',
			name: 'website.chat',
			serializeResult: (result) => ({ responseLength: result.content.length }),
		}, async (agentSpan) => {
			run.traceId = agentSpan.context.traceId;
			addEvent(run, 'Started agent trace', 'website.chat');

			const classification = await logger.trace({
				attributes: { 'tool.name': 'classifyPrompt' },
				kind: 'tool',
				name: 'prompt.classify',
				serializeResult: (result) => result,
			}, async () => {
				await pause(90);
				const wordCount = run.message.split(/\s+/).filter(Boolean).length;
				return { wordCount, category: wordCount > 18 ? 'detailed-request' : 'short-request' };
			});
			addEvent(run, 'Prepared model request', `${classification.category}, ${classification.wordCount} words`);

			const providerLabel = context.provider.kind === 'copilot' ? 'GitHub Copilot CLI' : context.provider.kind === 'offline-demo' ? 'Built-in offline demo' : 'OpenAI-compatible endpoint';
			addEvent(run, 'Calling model', providerLabel);
			const result = await logger.trace({
				attributes: { 'provider.mode': context.provider.kind },
				input: { message: run.message },
				kind: 'model',
				name: 'model.chat.completions',
				serializeResult: (reply) => ({ model: reply.model, provider: reply.provider, responseLength: reply.content.length }),
			}, async (modelSpan) => {
				const reply = context.provider.kind === 'copilot'
					? await requestCopilotReview(run, context, (name, attributes = {}) => modelSpan.addEvent(name, attributes))
					: await requestModel(run.message, context.provider);
				modelSpan.setAttributes({ 'model.name': reply.model, 'provider.name': reply.provider, 'response.mode': reply.mode });
				modelSpan.addEvent('response.received', { mode: reply.mode, responseLength: reply.content.length });
				if (reply.usage?.source !== undefined) {
					const model = text(reply.usage.models?.[0] ?? reply.usage.model);
					const provider = text(reply.usage.providers?.[0] ?? reply.usage.provider);
					modelSpan.setUsage({
						source: reply.usage.source,
						...(provider === undefined ? {} : { provider }),
						...(model === undefined ? {} : { model }),
						inputTokens: reply.usage.inputTokens,
						outputTokens: reply.usage.outputTokens,
						cacheReadTokens: reply.usage.cacheReadTokens,
						cacheWriteTokens: reply.usage.cacheWriteTokens,
						reasoningTokens: reply.usage.reasoningTokens,
						totalTokens: reply.usage.totalTokens,
					});
				}
				return reply;
			});
			run.response = result.content;
			run.usage = result.usage;
			addEvent(run, 'Received assistant response', `${result.provider} / ${result.model}`);
			agentSpan.addEvent('response.rendered', { responseLength: result.content.length });
			return result;
		});
	} catch (error) {
		failed = error;
		run.error = error instanceof Error ? error.message : String(error);
		addEvent(run, 'Run failed', run.error);
	} finally {
		const delivery = await logger.shutdown();
		run.delivery = delivery.success;
	}

	if (failed === undefined && run.traceId !== undefined) {
		try {
			run.trace = await loadTrace(context.collector, context.readerToken, run.traceId);
			addEvent(run, 'Trace stored locally', `${run.trace.spanCount} spans persisted`);
		} catch (error) {
			run.error = error instanceof Error ? error.message : String(error);
			addEvent(run, 'Trace readback failed', run.error);
		}
	}
	addEvent(run, 'Token usage', usageDetail(run.usage));
	run.status = failed === undefined && run.error === undefined ? 'completed' : 'failed';
}

function publicRun(run) {
	return {
		delivery: run.delivery,
		copilotSessionId: run.copilotSessionId,
		downloadReady: run.status !== 'running',
		error: run.error,
		events: run.events,
		id: run.id,
		response: run.response,
		status: run.status,
		trace: run.trace,
		traceId: run.traceId,
		usage: run.usage,
	};
}

function downloadRun(run) {
	return {
		exportedAt: new Date().toISOString(),
		interaction: {
			message: run.message,
			response: run.response,
		},
		run: publicRun(run),
		schemaVersion: 1,
	};
}

function publicConfig(provider) {
	return {
		collector: 'temporary local collector',
		mode: provider.kind,
		provider: provider.kind === 'copilot' ? 'GitHub Copilot CLI' : provider.kind === 'offline-demo' ? 'Built-in demo responder' : 'OpenAI-compatible endpoint',
		workspace: { files: SAMPLE_WORKSPACE_FILES, label: 'Harbor Inventory isolated workspace copy' },
	};
}

export async function startWebDashboard(options = {}) {
	const providerKind = options.provider ?? process.env.MODEL_WORKLOG_DEMO_PROVIDER ?? 'copilot';
	if (!['copilot', 'offline-demo', 'openai-compatible'].includes(providerKind)) {
		throw new Error('MODEL_WORKLOG_DEMO_PROVIDER must be copilot, offline-demo, or openai-compatible.');
	}
	const provider = {
		apiKey: options.apiKey ?? process.env.MODEL_WORKLOG_DEMO_OPENAI_API_KEY,
		endpoint: options.endpoint ?? process.env.MODEL_WORKLOG_DEMO_OPENAI_URL,
		kind: providerKind,
		model: options.model ?? process.env.MODEL_WORKLOG_DEMO_OPENAI_MODEL ?? 'gpt-4.1-mini',
	};
	const sampleWorkspacePath = await realpath(fileURLToPath(new URL('./sample-workspace', import.meta.url)));
	const workspacePath = await mkdtemp(join(tmpdir(), 'model-worklog-dashboard-workspace-'));
	await cp(sampleWorkspacePath, workspacePath, { recursive: true });
	const dataDirectory = await mkdtemp(join(tmpdir(), 'model-worklog-web-demo-'));
	const collector = await startSupervisor({
		dataDirectory,
		port: 0,
		tracePrivacy: { mode: 'redacted-content' },
	});
	const [writer, reader] = await Promise.all([
		createTraceCredential({ adminToken: collector.authToken, projects: [PROJECT_ID], role: 'writer', url: collector.url }),
		createTraceCredential({ adminToken: collector.authToken, projects: [PROJECT_ID], role: 'reader', url: collector.url }),
	]);
	await supervisorRequest(collector, collector.authToken, '/v1/workspaces/trust', 'POST', { workspacePath });
	const runs = new Map();
	const staticRoot = new URL('./public/', import.meta.url);
	const server = createServer((request, response) => {
		void (async () => {
			const url = new URL(request.url ?? '/', 'http://localhost');
			if (request.method === 'GET' && url.pathname === '/api/config') {
				sendJson(response, 200, publicConfig(provider));
				return;
			}
			if (request.method === 'GET' && url.pathname.startsWith('/api/runs/') && url.pathname.endsWith('/download')) {
				const runId = url.pathname.slice('/api/runs/'.length, -'/download'.length);
				const run = runs.get(runId);
				if (run === undefined) {
					sendError(response, 404, 'Run not found.');
					return;
				}
				if (run.status === 'running') {
					sendError(response, 409, 'The run log can be downloaded after the run finishes.');
					return;
				}
				sendDownload(response, `model-worklog-run-${run.id}.json`, downloadRun(run));
				return;
			}
			if (request.method === 'GET' && url.pathname.startsWith('/api/runs/')) {
				const run = runs.get(url.pathname.slice('/api/runs/'.length));
				if (run === undefined) {
					sendError(response, 404, 'Run not found.');
					return;
				}
				sendJson(response, 200, publicRun(run));
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/chat') {
				const body = await readRequestBody(request);
				const message = typeof body?.message === 'string' ? body.message.trim() : '';
				if (message === '' || message.length > MAX_MESSAGE_LENGTH) {
					sendError(response, 400, `message must contain 1 to ${MAX_MESSAGE_LENGTH} characters.`);
					return;
				}
				const run = { copilotMessages: [], events: [], id: randomUUID(), message, status: 'running' };
				runs.set(run.id, run);
				void executeRun(run, { collector, collectorToken: collector.authToken, provider, readerToken: reader.token, workspacePath, writerToken: writer.token });
				sendJson(response, 202, { runId: run.id });
				return;
			}
			const asset = STATIC_FILES.get(url.pathname);
			if (request.method !== 'GET' || asset === undefined) {
				sendError(response, 404, 'Not found.');
				return;
			}
			const contents = await import('node:fs/promises').then(({ readFile }) => readFile(new URL(asset.file, staticRoot)));
			response.writeHead(200, {
				'cache-control': 'no-store',
				'content-length': contents.byteLength,
				'content-security-policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'",
				'content-type': asset.contentType,
				'referrer-policy': 'no-referrer',
				'x-content-type-options': 'nosniff',
			});
			response.end(contents);
		})().catch((error) => {
			if (!response.headersSent) {
				sendError(response, 500, error instanceof Error ? error.message : 'Unexpected server error.');
			} else {
				response.destroy();
			}
		});
	});

	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(options.port ?? 0, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
	const port = server.address().port;
	let closed = false;
	return {
		close: async () => {
			if (closed) {
				return;
			}
			closed = true;
			await new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
			await collector.close();
			await rm(workspacePath, { force: true, recursive: true });
			await rm(dataDirectory, { force: true, recursive: true });
		},
		url: `http://127.0.0.1:${port}`,
	};
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
	const dashboard = await startWebDashboard();
	process.stdout.write(`Model Worklog web demo: ${dashboard.url}\n`);
	process.stdout.write('Press Ctrl+C to stop. The temporary local trace store will be removed.\n');
	const shutdown = async () => {
		await dashboard.close();
		process.exit(0);
	};
	process.once('SIGINT', () => { void shutdown(); });
	process.once('SIGTERM', () => { void shutdown(); });
}