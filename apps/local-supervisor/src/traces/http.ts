import type { IncomingMessage, ServerResponse } from 'node:http';

import { TraceApi } from './application/api';
import { TraceError } from './domain/contracts';
import { otlpBatch } from './otlp/convert';
import { decodeOtlp } from './otlp/decode';
import type { OtlpEncoding } from './otlp/protocol';
import { OTLP_TRACES_PATH, otlpResponse, otlpResponseEncoding, requireOtlpEncoding } from './otlp/transport';

export type TraceRequestHandler = ((request: IncomingMessage, response: ServerResponse) => Promise<void>) & {
	supports(pathname: string): boolean;
};
export const MAX_TRACE_REQUEST_BYTES = 2 * 1024 * 1024;

function browserGuard(request: IncomingMessage): void {
	const host = request.headers.host;
	const port = request.socket.localPort;
	const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
	if (port === 80) { allowed.push('127.0.0.1', 'localhost', '[::1]'); }
	if (host === undefined || !allowed.includes(host)) { throw new TraceError(403, 'origin_forbidden', 'Only same-origin loopback requests are permitted.'); }
	const origin = request.headers.origin;
	const site = request.headers['sec-fetch-site'];
	if ((origin !== undefined && origin !== new URL(`http://${host}`).origin) || site === 'cross-site' || site === 'same-site') {
		throw new TraceError(403, 'origin_forbidden', 'Cross-origin browser requests are not permitted.');
	}
}

function readBody(request: IncomingMessage): Promise<Buffer> {
	const length = request.headers['content-length'];
	if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) > MAX_TRACE_REQUEST_BYTES)) {
		throw new TraceError(413, 'body_too_large', 'Trace request bodies are limited to 2097152 bytes.');
	}
	return new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (error?: TraceError): void => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			request.removeListener('data', onData);
			request.removeListener('end', onEnd);
			request.removeListener('aborted', onAborted);
			request.removeListener('error', onAborted);
			if (error !== undefined) { chunks.length = 0; request.resume(); reject(error); return; }
			resolve(Buffer.concat(chunks));
		};
		const onData = (chunk: Buffer): void => {
			size += chunk.length;
			if (size > MAX_TRACE_REQUEST_BYTES) { finish(new TraceError(413, 'body_too_large', 'Trace request bodies are limited to 2097152 bytes.')); }
			else { chunks.push(chunk); }
		};
		const onEnd = (): void => { finish(); };
		const onAborted = (): void => { finish(new TraceError(400, 'body_interrupted', 'The request body was interrupted.')); };
		const timer = setTimeout(() => { finish(new TraceError(400, 'body_timeout', 'The request body did not finish within 10 seconds.')); }, 10_000);
		timer.unref();
		request.on('data', onData);
		request.once('end', onEnd);
		request.once('aborted', onAborted);
		request.once('error', onAborted);
	});
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
	const contentType = request.headers['content-type'];
	if (contentType === undefined || !/^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(contentType)) {
		throw new TraceError(400, 'content_type_required', 'Content-Type application/json is required.');
	}
	const bytes = await readBody(request);
	try {
		const payload = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
		return JSON.parse(payload, (key: string, value: unknown): unknown => {
			if (['__proto__', 'constructor', 'prototype'].includes(key)) { throw new Error('Unsafe JSON key.'); }
			return value;
		}) as unknown;
	} catch { throw new TraceError(400, 'invalid_json', 'The request body must contain valid UTF-8 JSON without prototype keys.'); }
}

function respond(response: ServerResponse, statusCode: number, body: unknown, contentType = 'application/json; charset=utf-8'): void {
	if (response.destroyed || response.writableEnded) { return; }
	const payload = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
	response.writeHead(statusCode, {
		'content-type': contentType, 'content-length': payload.length,
		'cache-control': 'no-store', 'content-security-policy': "default-src 'none'", 'x-content-type-options': 'nosniff',
		'cross-origin-resource-policy': 'same-origin', 'referrer-policy': 'no-referrer',
		...(statusCode >= 400 ? { connection: 'close' } : {}),
	});
	response.end(payload);
}

function respondOtlp(response: ServerResponse, encoding: OtlpEncoding, error?: TraceError): void {
	const reply = otlpResponse(encoding, error);
	respond(response, error?.status ?? 200, reply.payload, reply.contentType);
}

async function discardRejectedBody(request: IncomingMessage): Promise<void> {
	if (request.complete || request.destroyed) { request.resume(); return; }
	await new Promise<void>((resolve) => {
		const finish = (): void => {
			clearTimeout(timer);
			request.removeListener('end', finish);
			request.removeListener('close', finish);
			resolve();
		};
		const timer = setTimeout(finish, 1_000);
		timer.unref();
		request.once('end', finish);
		request.once('close', finish);
		request.resume();
	});
}

export function createTraceHandler(api: TraceApi): TraceRequestHandler {
	const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
		request.on('error', () => undefined);
		const responseEncoding = otlpResponseEncoding(request);
		try {
			const token = request.headers['x-model-worklog-token'];
			const principal = api.credentials.authenticate(typeof token === 'string' ? token : undefined);
			browserGuard(request);
			if ((request.url?.length ?? 0) > 4_096) { throw new TraceError(400, 'invalid_url', 'Trace request URLs are limited to 4096 characters.'); }
			const url = new URL(request.url ?? '/', 'http://localhost');
			const method = request.method ?? 'GET';
			const selected = api.authorize(principal, method, url.pathname);
			if (selected.kind === 'otlp') {
				const encoding = requireOtlpEncoding(request);
				const projectId = api.otlpProject(principal, request.headers['x-model-worklog-project']);
				const body = otlpBatch(decodeOtlp(await readBody(request), encoding), projectId);
				api.handle(selected, principal, url.searchParams, body);
				respondOtlp(response, encoding);
				return;
			}
			const body = method === 'POST' ? await jsonBody(request) : undefined;
			request.resume();
			const result = api.handle(selected, principal, url.searchParams, body);
			respond(response, result.statusCode, result.body);
		} catch (error) {
			await discardRejectedBody(request);
			const failure = error instanceof TraceError ? error : new TraceError(500, 'internal_error', 'Trace operation failed; no successful acknowledgement was issued.');
			if (responseEncoding !== undefined) { respondOtlp(response, responseEncoding, failure); }
			else { respond(response, failure.status, { error: { code: failure.code, message: failure.message } }); }
		}
	};
	return Object.assign(handler, { supports: (pathname: string): boolean => pathname === '/v2' || pathname.startsWith('/v2/') || pathname === OTLP_TRACES_PATH });
}