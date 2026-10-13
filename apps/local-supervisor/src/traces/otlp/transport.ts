import type { IncomingMessage } from 'node:http';
import { Writer } from 'protobufjs';

import { TraceError } from '../domain/contracts';
import { exportTraceResponse, type OtlpEncoding } from './protocol';

export const OTLP_TRACES_PATH = '/v1/traces';

function contentType(input: string | undefined): OtlpEncoding | undefined {
	if (input !== undefined && /^application\/json(?:\s*;\s*charset=(?:utf-8|"utf-8"))?\s*$/i.test(input)) { return 'json'; }
	if (input !== undefined && /^application\/x-protobuf\s*$/i.test(input)) { return 'protobuf'; }
	return undefined;
}

export function otlpResponseEncoding(request: IncomingMessage): OtlpEncoding | undefined {
	try {
		return new URL(request.url ?? '/', 'http://localhost').pathname === OTLP_TRACES_PATH ? contentType(request.headers['content-type']) ?? 'json' : undefined;
	} catch { return undefined; }
}

export function requireOtlpEncoding(request: IncomingMessage): OtlpEncoding {
	const compression = request.headers['content-encoding'];
	if (compression !== undefined && (typeof compression !== 'string' || !/^identity$/i.test(compression))) {
		throw new TraceError(415, 'unsupported_content_encoding', 'OTLP compression is not supported; omit Content-Encoding or use identity.');
	}
	const encoding = contentType(request.headers['content-type']);
	if (encoding === undefined) { throw new TraceError(415, 'unsupported_content_type', 'OTLP requires application/json or application/x-protobuf.'); }
	return encoding;
}

export function otlpResponse(encoding: OtlpEncoding, error?: TraceError): { payload: Buffer; contentType: string } {
	if (encoding === 'json') { return { payload: Buffer.from(JSON.stringify(error === undefined ? {} : { message: error.message })), contentType: 'application/json' }; }
	const payload = error === undefined ? exportTraceResponse.encode({}).finish() : Writer.create().uint32(18).string(error.message).finish();
	return { payload: Buffer.from(payload), contentType: 'application/x-protobuf' };
}