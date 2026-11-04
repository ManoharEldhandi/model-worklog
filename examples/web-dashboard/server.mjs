import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLocalModelLogger, LocalSupervisorClient } from 'model-worklog-sdk';
import { buildSessionLog, buildTraceLog, LogQueryRequestSchema, parseSessionEvent, redactAttributes, redactSensitiveText, SpanIdSchema, TraceDetailSchema, TraceIdSchema } from 'model-worklog-schema';
import { CopilotLogAnswerGenerator, createTraceCredential, OpenAiLogAnswerGenerator, startSupervisor } from 'model-worklog-supervisor';

import { captureRefundReview, captureSampleReview } from './sampleCapture.mjs';
import { createSdkLogQuery } from './sdkLogQueries.mjs';
import { ChromaLogVectorStore, HttpLogRagReranker, LogRag, OpenAiLogEmbedder } from 'model-worklog-sdk/rag';
import { projectActivitySpans, projectToolSpans } from './toolProjection.mjs';

const PROJECT_ID = 'web-demo';
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_REQUEST_BYTES = 128 * 1024;
const SAMPLE_WORKSPACE_FILES = ['README.md', 'src/inventory.ts', 'src/pricing.ts'];
const COPILOT_MAX_DURATION_MS = 120_000;
const STATIC_FILES = new Map([
	['/', { file: 'index.html', contentType: 'text/html; charset=utf-8' }],
	['/app.js', { file: 'app.js', contentType: 'text/javascript; charset=utf-8' }],
	['/markdown.js', { file: 'markdown.js', contentType: 'text/javascript; charset=utf-8' }],
	['/logConversation.js', { file: 'logConversation.js', contentType: 'text/javascript; charset=utf-8' }],
	['/vendor/marked.js', { file: '../../../node_modules/marked/lib/marked.esm.js', contentType: 'text/javascript; charset=utf-8' }],
	['/vendor/purify.js', { file: '../../../node_modules/dompurify/dist/purify.es.mjs', contentType: 'text/javascript; charset=utf-8' }],
	['/styles.css', { file: 'styles.css', contentType: 'text/css; charset=utf-8' }],
	['/logo.png', { file: '../../../apps/vscode-extension/media/model-logger.png', contentType: 'image/png' }],
]);

function pause(milliseconds) {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function responseBody(response) {
	return JSON.stringify(response);
}

class DashboardHttpError extends Error {
	constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function guardRequest(request) {
	const allowed = ['127.0.0.1', 'localhost', '[::1]'].map((host) => `${host}:${request.socket.localPort}`);
	const host = request.headers.host;
	if (!allowed.includes(host) || (request.headers.origin !== undefined && request.headers.origin !== `http://${host}`)
		|| ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) {
		throw new DashboardHttpError(403, 'Only same-origin loopback requests are permitted.');
	}
}

function sendJson(response, statusCode, body) {
	if (response.destroyed || response.writableEnded) { return; }
	const payload = responseBody(body);
	response.writeHead(statusCode, {
		'cache-control': 'no-store',
		'content-length': Buffer.byteLength(payload),
		'content-security-policy': "default-src 'self'; base-uri 'none'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; script-src 'self'; style-src 'self'",
		'content-type': 'application/json; charset=utf-8',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
		...(statusCode >= 400 ? { connection: 'close' } : {}),
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
	if (!/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(request.headers['content-type'] ?? '')) {
		throw new DashboardHttpError(400, 'Content-Type application/json is required.');
	}
	const length = request.headers['content-length'];
	if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_REQUEST_BYTES)) { throw new DashboardHttpError(413, 'Request body is too large.'); }
	const chunks = [];
	let bytes = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		bytes += buffer.length;
		if (bytes > MAX_REQUEST_BYTES) {
			throw new DashboardHttpError(413, 'Request body is too large.');
		}
		chunks.push(buffer);
	}
	try {
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)), (key, value) => {
			if (['__proto__', 'constructor', 'prototype'].includes(key)) { throw new Error('Unsafe key.'); }
			return value;
		});
	} catch { throw new DashboardHttpError(400, 'Expected valid UTF-8 JSON without prototype keys.'); }
}

function addEvent(run, kind, payload, correlationId) {
	const clean = redactAttributes(payload, { mode: 'redacted-content', maxStringLength: 16_000 });
	run.events.push({
		schemaVersion: 1,
		eventId: randomUUID(),
		sessionId: run.id,
		sequence: run.events.length + 1,
		occurredAt: new Date().toISOString(),
		actor: 'web-dashboard',
		evidenceGrade: 'model-declared',
		kind,
		payload: clean.attributes,
		...(correlationId === undefined ? {} : { correlationId }),
		redaction: { policyVersion: '1', replacements: clean.report.redactedFields, truncated: clean.report.truncatedFields > 0 },
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
		activity: spans.length === 0 ? [] : buildTraceLog(spans, { projectId: spans[0].span.projectId, traceId: spans[0].span.traceId }).entries,
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

async function supervisorRequest(collector, token, pathname, method, body, options = {}) {
	const response = await fetch(new URL(pathname, collector.url), {
		method,
		headers: {
			'x-model-worklog-token': token,
			...(body === undefined ? {} : { 'content-type': 'application/json' }),
		},
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
		signal: AbortSignal.any([AbortSignal.timeout(options.timeoutMs ?? 10_000), ...(options.signal === undefined ? [] : [options.signal])]),
	});
	const payload = await response.json();
	if (!response.ok) {
		throw new DashboardHttpError(response.status, payload?.error?.message ?? `Supervisor returned HTTP ${response.status}.`);
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

function describeCopilotEvent(run, event, recordTraceEvent) {
	const parsed = parseSessionEvent(event);
	if (!parsed.ok || run.copilotEvents.some((existing) => existing.eventId === event.eventId)) { return; }
	const clean = redactAttributes(parsed.value.payload, { mode: 'redacted-content', maxStringLength: 16_000 });
	const captured = { ...parsed.value, payload: clean.attributes };
	run.copilotEvents.push(captured);
	if (captured.kind === 'agent.message' && captured.payload.role === 'assistant' && typeof captured.payload.text === 'string') {
		run.copilotMessages.push(captured.payload.text);
	}
	if (captured.payload.delta === true) { return; }
	recordTraceEvent(captured.kind, {
		...(typeof captured.payload.tool === 'string' ? { tool: captured.payload.tool } : {}),
		...(typeof captured.payload.path === 'string' ? { path: captured.payload.path } : {}),
	});
}

function copilotTask(message) {
	return [
		'You are reviewing the current sample workspace in read-only mode.',
		'Do not create, edit, rename, or delete files. Do not run commands that modify the workspace.',
		'Read the files needed to answer the user request, then give a concise response with filenames.',
		`User request: ${message}`,
	].join('\n\n');
}

async function requestCopilotReview(run, context, recordTraceEvent, parent) {
	recordTraceEvent('copilot.review.started', { workspace: 'isolated-copy' });
	const started = await supervisorRequest(context.collector, context.collectorToken, '/v1/copilot-sessions', 'POST', {
		maxDurationMs: COPILOT_MAX_DURATION_MS,
		captureReasoning: true,
		task: copilotTask(run.message),
		workspacePath: context.workspacePath,
		...(context.provider.model === undefined ? {} : { model: context.provider.model }),
	});
	const sessionId = text(value(value(started, 'session'), 'sessionId'));
	if (sessionId === undefined) {
		throw new Error('Supervisor did not return a Copilot session ID.');
	}
	run.copilotSessionId = sessionId;
	const reader = new LocalSupervisorClient({ supervisorUrl: context.collector.url, token: context.collectorToken });
	let afterSequence = 0;
	let terminal = false;
	while (!terminal) {
		run.log = await reader.getLog(sessionId);
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
	run.log = await reader.getLog(sessionId);
	const completed = await supervisorRequest(context.collector, context.collectorToken, `/v1/sessions/${encodeURIComponent(sessionId)}`, 'GET');
	const session = value(completed, 'session');
	const state = text(value(session, 'state'));
	const projected = [...projectToolSpans(run.copilotEvents, { projectId: PROJECT_ID, parent }), ...projectActivitySpans(run.log, { projectId: PROJECT_ID, parent })];
	for (let offset = 0; offset < projected.length; offset += 100) {
		await supervisorRequest(context.collector, context.writerToken, '/v2/traces/batch', 'POST', { schemaVersion: 1, spans: projected.slice(offset, offset + 100) });
	}
	if (state !== 'completed') {
		throw new Error(`Copilot session ended with state ${state ?? 'unknown'}. Run copilot login if authentication is required.`);
	}
	const finalMessage = [...run.copilotEvents].reverse().find((event) => event.kind === 'agent.message' && event.payload.role === 'assistant' && event.payload.delta !== true && event.payload.agentId === undefined);
	const content = typeof finalMessage?.payload.text === 'string' ? finalMessage.payload.text : '';
	const usage = usageFromSession(session);
	const model = usage?.models.length === 1 ? text(usage.models[0]) : undefined;
	return {
		content: content === '' ? 'Copilot completed without returning a visible assistant message.' : content,
		mode: 'copilot-cli',
		...(model === undefined ? {} : { model }),
		provider: 'github-copilot',
		usage,
	};
}

async function loadTrace(collector, readerToken, traceId) {
	const spans = [];
	let cursor;
	for (let page = 0; page < 20; page += 1) {
		const params = new URLSearchParams({ projectId: PROJECT_ID, limit: '1000', ...(cursor === undefined ? {} : { cursor }) });
		const payload = TraceDetailSchema.parse(await supervisorRequest(collector, readerToken, `/v2/traces/${traceId}?${params}`, 'GET'));
		spans.push(...payload.spans);
		if (payload.nextCursor === null) { return { schemaVersion: 1, spans, nextCursor: null }; }
		cursor = payload.nextCursor;
	}
	throw new Error('Trace readback exceeded the bounded page limit.');
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
			const providerLabel = context.provider.kind === 'copilot' ? 'GitHub Copilot CLI' : context.provider.kind === 'offline-demo' ? 'Built-in offline demo' : 'OpenAI-compatible endpoint';
			addEvent(run, 'adapter.lifecycle', { adapter: providerLabel, phase: 'request-started' });
			const result = await logger.trace({
				attributes: { 'provider.mode': context.provider.kind },
				input: { message: run.message },
				kind: 'model',
				name: 'model.chat.completions',
				serializeResult: (reply) => ({ ...(reply.model === undefined ? {} : { model: reply.model }), provider: reply.provider, response: reply.content }),
			}, async (modelSpan) => {
				const reply = context.provider.kind === 'copilot'
					? await requestCopilotReview(run, context, (name, attributes = {}) => modelSpan.addEvent(name, attributes), modelSpan.context)
					: await requestModel(run.message, context.provider);
				modelSpan.setAttributes({ ...(reply.model === undefined ? {} : { 'model.name': reply.model }), 'provider.name': reply.provider, 'response.mode': reply.mode });
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
			if (context.provider.kind !== 'copilot') {
				addEvent(run, 'agent.message', { role: 'assistant', text: result.content });
			}
			agentSpan.addEvent('response.rendered', { responseLength: result.content.length });
			return result;
		});
	} catch (error) {
		failed = error;
		run.error = redactSensitiveText(error instanceof Error ? error.message : String(error));
		addEvent(run, 'session.failed', { state: 'failed', message: run.error });
	} finally {
		const delivery = await logger.shutdown();
		run.delivery = delivery.success;
		if (!delivery.success) {
			addEvent(run, 'log.truncated', { message: 'Telemetry delivery is incomplete.', pending: delivery.pending, dropped: delivery.dropped });
		}
	}

	if (run.traceId !== undefined) {
		try {
			run.storedTrace = await loadTrace(context.collector, context.readerToken, run.traceId);
			run.trace = summarizeTrace(run.storedTrace);
		} catch (error) {
			run.error = redactSensitiveText(error instanceof Error ? error.message : String(error));
			addEvent(run, 'adapter.lifecycle', { adapter: 'collector', phase: 'readback-failed', message: run.error });
		}
	}
	if (!run.copilotEvents.some((event) => event.kind === 'usage.reported')) {
		addEvent(run, run.usage === undefined ? 'usage.unavailable' : 'usage.reported', run.usage === undefined
			? { message: 'Not reported by the provider.' } : JSON.parse(JSON.stringify(run.usage)));
	}
	run.status = failed === undefined && run.error === undefined ? 'completed' : 'failed';
	if (run.status === 'completed') { addEvent(run, 'session.completed', {}); }
}

function publicRun(run) {
	const log = run.log ?? buildSessionLog(run.events, { sessionId: run.id, state: run.status === 'running' ? 'running' : run.status === 'completed' ? 'completed' : 'failed' });
	return {
		log,
		activity: { schemaVersion: 1, entries: log.entries, sourceCount: log.sourceCount },
		delivery: run.delivery,
		copilotSessionId: run.copilotSessionId,
		downloadReady: run.status !== 'running',
		error: run.error,
		events: run.events,
		id: run.id,
		response: run.response === undefined ? undefined : redactSensitiveText(run.response),
		status: run.status,
		trace: run.trace,
		traceId: run.traceId,
		usage: run.usage,
	};
}

async function executeSampleRun(run, context) {
	try {
		const capture = run.scenario === 'refund' ? captureRefundReview : captureSampleReview;
		const result = await capture({ endpoint: context.collector.url, token: context.writerToken, projectId: PROJECT_ID, workspacePath: context.workspacePath, onEvent: (kind, payload, correlationId) => addEvent(run, kind, payload, correlationId) });
		run.traceId = result.traceId;
		run.delivery = result.delivery;
		run.storedTrace = await loadTrace(context.collector, context.readerToken, result.traceId);
		run.trace = summarizeTrace(run.storedTrace);
		run.response = run.scenario === 'refund' ? 'Refund review captured. The payment was outside the refund window; the amount was not recorded.' : 'Sample capture complete: 120 file reads, one workspace search, and one handled stock validation failure.';
		run.status = 'completed';
		addEvent(run, 'session.completed', {});
	} catch (error) {
		run.status = 'failed';
		run.error = redactSensitiveText(error instanceof Error ? error.message : 'Sample capture failed.');
		addEvent(run, 'session.failed', { message: run.error });
	}
}

function downloadRun(run) {
	return {
		exportedAt: new Date().toISOString(),
		interaction: {
			message: redactSensitiveText(run.message),
			response: run.response === undefined ? undefined : redactSensitiveText(run.response),
		},
		metadata: {
			activitySchemaVersion: 1,
			underlyingExecutionComplete: false,
			privacy: 'Redacted captured activity. Review before sharing. Provider-hidden reasoning is not collected.',
		},
		sourceEvents: [...run.events, ...run.copilotEvents],
		storedSpans: run.storedTrace?.spans ?? [],
		run: publicRun(run),
		schemaVersion: 1,
	};
}

function rememberRun(runs, run) {
	for (const [id, previous] of runs) {
		if (runs.size < 20) { break; }
		if (previous.status !== 'running') { runs.delete(id); }
	}
	runs.set(run.id, run);
}

function publicConfig(provider, modelSynthesis, semanticSearch) {
	return {
		collector: 'temporary local collector',
		mode: provider.kind,
		modelSynthesis,
		semanticSearch,
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
		model: options.model ?? (providerKind === 'openai-compatible' ? process.env.MODEL_WORKLOG_DEMO_OPENAI_MODEL ?? 'gpt-4.1-mini' : undefined),
	};
	const logAnswerGenerator = options.logAnswerGenerator ?? (provider.kind === 'copilot'
		? new CopilotLogAnswerGenerator({ model: provider.model })
		: provider.kind === 'openai-compatible' && provider.endpoint !== undefined ? new OpenAiLogAnswerGenerator({ endpoint: provider.endpoint, model: provider.model, apiKey: provider.apiKey }) : undefined);
	const sampleWorkspacePath = await realpath(fileURLToPath(new URL('./sample-workspace', import.meta.url)));
	const workspacePath = await mkdtemp(join(tmpdir(), 'model-worklog-dashboard-workspace-'));
	await cp(sampleWorkspacePath, workspacePath, { recursive: true });
	const dataDirectory = await mkdtemp(join(tmpdir(), 'model-worklog-web-demo-'));
	const collector = await startSupervisor({
		dataDirectory,
		port: 0,
		tracePrivacy: { mode: 'redacted-content' },
		copilotRelayFactory: options.copilotRelayFactory,
		logAnswerGenerator,
	});
	const [writer, reader] = await Promise.all([
		createTraceCredential({ adminToken: collector.authToken, projects: [PROJECT_ID], role: 'writer', url: collector.url }),
		createTraceCredential({ adminToken: collector.authToken, projects: [PROJECT_ID], role: 'reader', url: collector.url }),
	]);
	const ragOptions = options.ragOptions ?? (process.env.MODEL_WORKLOG_CHROMA_URL && process.env.MODEL_WORKLOG_EMBEDDING_URL ? {
		store: new ChromaLogVectorStore({ url: process.env.MODEL_WORKLOG_CHROMA_URL, collection: `web-demo-${randomUUID()}` }),
		embedder: new OpenAiLogEmbedder({ endpoint: process.env.MODEL_WORKLOG_EMBEDDING_URL, model: 'BAAI/bge-small-en-v1.5', queryPrefix: 'query: ', documentPrefix: 'passage: ' }),
		...(process.env.MODEL_WORKLOG_RERANK_URL ? { reranker: new HttpLogRagReranker(process.env.MODEL_WORKLOG_RERANK_URL) } : {}),
	} : undefined);
	const rag = options.rag ?? (ragOptions ? new LogRag(ragOptions) : undefined);
	const queryLogs = rag ? createSdkLogQuery({ client: new LocalSupervisorClient({ supervisorUrl: collector.url, token: reader.token }), rag, generator: logAnswerGenerator }) : undefined;
	await supervisorRequest(collector, collector.authToken, '/v1/workspaces/trust', 'POST', { workspacePath });
	const runs = new Map();
	const activeQueries = new Set();
	let activeSample;
	const staticRoot = new URL('./public/', import.meta.url);
	const server = createServer((request, response) => {
		void (async () => {
			guardRequest(request);
			if ((request.url?.length ?? 0) > 4096) { throw new DashboardHttpError(400, 'Request URL is too long.'); }
			const url = new URL(request.url ?? '/', 'http://localhost');
			if (request.method === 'POST' && url.pathname === '/api/logs/query') {
				if (url.search !== '') { throw new DashboardHttpError(400, 'Query parameters are not supported.'); }
				const body = await readRequestBody(request);
				if (body === null || typeof body !== 'object' || Array.isArray(body) || (body.projectId !== undefined && body.projectId !== PROJECT_ID)) { throw new DashboardHttpError(400, 'Only the demo project can be queried.'); }
				const parsed = LogQueryRequestSchema.safeParse({ ...body, projectId: PROJECT_ID });
				if (!parsed.success) { throw new DashboardHttpError(400, 'Enter a question of 1-2000 characters and valid scope filters.'); }
				const cancellation = new AbortController();
				activeQueries.add(cancellation);
				const abort = () => cancellation.abort();
				response.once('close', abort);
				try {
					let answer;
					if (queryLogs) {
						try { answer = await queryLogs(parsed.data, cancellation.signal); }
						catch { cancellation.signal.throwIfAborted(); throw new DashboardHttpError(503, 'Semantic log search is unavailable. Restart the RAG demo and check its local service logs.'); }
					} else { answer = await supervisorRequest(collector, reader.token, '/v2/logs/query', 'POST', parsed.data, { timeoutMs: 55_000, signal: cancellation.signal }); }
					sendJson(response, 200, answer);
				} finally { activeQueries.delete(cancellation); response.removeListener('close', abort); }
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/logs/evidence') {
				if ([...url.searchParams.keys()].some((key) => !['traceId', 'spanId'].includes(key)) || [...url.searchParams.keys()].length !== 2) { throw new DashboardHttpError(400, 'Expected exactly traceId and spanId.'); }
				const trace = TraceIdSchema.safeParse(url.searchParams.get('traceId'));
				const span = SpanIdSchema.safeParse(url.searchParams.get('spanId'));
				if (!trace.success || !span.success) { throw new DashboardHttpError(400, 'Invalid evidence identifiers.'); }
				const detail = await loadTrace(collector, reader.token, trace.data);
				const source = detail.spans.find((stored) => stored.span.spanId === span.data);
				if (source === undefined) { throw new DashboardHttpError(404, 'The evidence span is no longer retained.'); }
				sendJson(response, 200, source);
				return;
			}
			if (request.method === 'POST' && url.pathname === '/api/logs/sample') {
				const body = await readRequestBody(request);
				if (body === null || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => key !== 'scenario') || (body.scenario !== undefined && !['inventory', 'refund'].includes(body.scenario))) { throw new DashboardHttpError(400, 'Choose the inventory or refund sample.'); }
				if ([...runs.values()].some((run) => run.status === 'running')) { throw new DashboardHttpError(409, 'A capture is already running.'); }
				const run = { copilotMessages: [], copilotEvents: [], events: [], id: randomUUID(), scenario: body.scenario ?? 'inventory', message: body.scenario === 'refund' ? 'Refund investigation sample' : 'Inventory sample capture', status: 'running' };
				rememberRun(runs, run);
				activeSample = executeSampleRun(run, { collector, writerToken: writer.token, readerToken: reader.token, workspacePath }).finally(() => { activeSample = undefined; });
				sendJson(response, 202, { runId: run.id });
				return;
			}
			if (request.method === 'GET' && url.pathname === '/api/config') {
				sendJson(response, 200, publicConfig(provider, logAnswerGenerator !== undefined, rag !== undefined));
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
				if ([...runs.values()].some((run) => run.status === 'running')) { throw new DashboardHttpError(409, 'A capture is already running.'); }
				const message = typeof body?.message === 'string' ? body.message.trim() : '';
				if (message === '' || message.length > MAX_MESSAGE_LENGTH) {
					sendError(response, 400, `message must contain 1 to ${MAX_MESSAGE_LENGTH} characters.`);
					return;
				}
				const run = { copilotMessages: [], copilotEvents: [], events: [], id: randomUUID(), message, status: 'running' };
				addEvent(run, 'agent.message', { role: 'user', text: message });
				rememberRun(runs, run);
				void executeRun(run, { collector, collectorToken: collector.authToken, provider, readerToken: reader.token, workspacePath, writerToken: writer.token }).catch((error) => {
					run.error = redactSensitiveText(error instanceof Error ? error.message : String(error));
					run.status = 'failed';
					addEvent(run, 'session.failed', { state: 'failed', message: run.error });
				});
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
			request.resume();
			if (!response.headersSent) {
				sendError(response, error instanceof DashboardHttpError ? error.statusCode : 500, error instanceof DashboardHttpError ? error.message : 'The local dashboard request failed.');
			} else {
				response.destroy();
			}
		});
	});

	server.headersTimeout = 10_000;
	server.requestTimeout = 15_000;
	server.keepAliveTimeout = 5_000;
	server.maxConnections = 64;
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
			for (const cancellation of activeQueries) { cancellation.abort(); }
			const stopped = new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error)));
			server.closeAllConnections();
			await stopped;
			await activeSample;
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
