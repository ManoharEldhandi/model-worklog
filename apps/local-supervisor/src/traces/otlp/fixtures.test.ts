import { Writer } from 'protobufjs';

import { exportTraceRequest, type OtlpRequest, type OtlpSpan } from './protocol';

export const traceId = 'abcdef0123456789abcdef0123456789';
export const spanId = '1234567890abcdef';
export const startNano = '1791849600123456789';
export const endNano = '1791849601123456790';

export function jsonSpan(overrides: Partial<OtlpSpan> = {}): OtlpSpan {
	return {
		traceId, spanId, parentSpanId: '1111111111111111', traceState: 'vendor=value', flags: 769,
		name: 'chat', kind: 3, startTimeUnixNano: startNano, endTimeUnixNano: endNano,
		attributes: [
			{ key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
			{ key: 'gen_ai.usage.input_tokens', value: { intValue: '7' } },
			{ key: 'nested', value: { kvlistValue: { values: [{ key: 'values', value: { arrayValue: { values: [
				{ boolValue: true }, { intValue: '-9223372036854775808' }, { doubleValue: 1.25 }, { bytesValue: 'AP8=' }, {},
			] } } }] } } },
		],
		events: [{ timeUnixNano: startNano, name: 'checkpoint', attributes: [{ key: 'ok', value: { boolValue: false } }], droppedAttributesCount: 1 }],
		links: [{ traceId: 'fedcba9876543210fedcba9876543210', spanId: '2222222222222222', traceState: 'link=value', flags: 1,
			attributes: [{ key: 'weight', value: { doubleValue: 0.5 } }], droppedAttributesCount: 2 }],
		status: { message: 'provider failure', code: 2 }, droppedAttributesCount: 3, droppedEventsCount: 4, droppedLinksCount: 5,
		...overrides,
	};
}

export function jsonRequest(spans: OtlpSpan[] = [jsonSpan()]): OtlpRequest {
	return { resourceSpans: [{
		resource: { attributes: [{ key: 'service.name', value: { stringValue: 'otlp-test' } }], droppedAttributesCount: 1 },
		schemaUrl: 'https://opentelemetry.io/schemas/1.40.0',
		scopeSpans: [{ scope: { name: 'test.instrumentation', version: '1.0', attributes: [{ key: 'scope', value: { stringValue: 'test' } }], droppedAttributesCount: 2 },
			schemaUrl: 'https://opentelemetry.io/schemas/1.40.0', spans }],
	}] };
}

export function binaryRequest(input: OtlpRequest): Buffer {
	const bytes = (value: unknown, key = ''): unknown => {
		if (typeof value === 'string' && ['traceId', 'spanId', 'parentSpanId'].includes(key)) { return Buffer.from(value, 'hex'); }
		if (Array.isArray(value)) { return value.map((entry: unknown) => bytes(entry)); }
		if (value !== null && typeof value === 'object') { return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, bytes(entry, name)])); }
		return value;
	};
	return Buffer.from(exportTraceRequest.encode(exportTraceRequest.fromObject(bytes(input) as Record<string, unknown>)).finish());
}

export function message(writer: Writer, field: number, value: Writer | Uint8Array): Writer {
	return writer.uint32(field * 8 + 2).bytes(value instanceof Writer ? value.finish() : value);
}

export function wireRequest(span: Writer | Uint8Array): Buffer {
	const scope = message(Writer.create(), 1, Writer.create().uint32(10).string('test.instrumentation').uint32(18).string('1.0'));
	message(scope, 2, span);
	const resource = message(Writer.create(), 1, Writer.create().uint32(10).string('service.name').uint32(18).bytes(Writer.create().uint32(10).string('otlp-test').finish()));
	const group = message(message(Writer.create(), 1, resource), 2, scope);
	return Buffer.from(message(Writer.create(), 1, group).finish());
}

export function wireSpan(): Writer {
	const span = Writer.create().uint32(10).bytes(Buffer.from(traceId, 'hex')).uint32(18).bytes(Buffer.from(spanId, 'hex'))
		.uint32(26).string('vendor=value').uint32(34).bytes(Buffer.from('1111111111111111', 'hex'))
		.uint32(42).string('chat').uint32(48).int32(3).uint32(57).fixed64(startNano).uint32(65).fixed64(endNano);
	message(span, 9, message(Writer.create().uint32(10).string('gen_ai.operation.name'), 2, Writer.create().uint32(10).string('chat')));
	message(span, 9, message(Writer.create().uint32(10).string('gen_ai.usage.input_tokens'), 2, Writer.create().uint32(24).int64(7)));
	const array = Writer.create();
	for (const value of [Writer.create().uint32(16).bool(true), Writer.create().uint32(24).int64('-9223372036854775808'),
		Writer.create().uint32(33).double(1.25), Writer.create().uint32(58).bytes(Buffer.from([0, 255])), Writer.create()]) { message(array, 1, value); }
	const nested = message(Writer.create(), 1, message(Writer.create().uint32(10).string('values'), 2, message(Writer.create(), 5, array)));
	message(span, 9, message(Writer.create().uint32(10).string('nested'), 2, message(Writer.create(), 6, nested)));
	const event = Writer.create().uint32(9).fixed64(startNano).uint32(18).string('checkpoint');
	message(event, 3, message(Writer.create().uint32(10).string('ok'), 2, Writer.create().uint32(16).bool(false)));
	message(span, 11, event.uint32(32).uint32(1));
	const link = Writer.create().uint32(10).bytes(Buffer.from('fedcba9876543210fedcba9876543210', 'hex'))
		.uint32(18).bytes(Buffer.from('2222222222222222', 'hex')).uint32(26).string('link=value');
	message(link, 4, message(Writer.create().uint32(10).string('weight'), 2, Writer.create().uint32(33).double(0.5)));
	message(span, 13, link.uint32(40).uint32(2).uint32(53).fixed32(1));
	message(span, 15, Writer.create().uint32(18).string('provider failure').uint32(24).int32(2));
	return span.uint32(80).uint32(3).uint32(96).uint32(4).uint32(112).uint32(5).uint32(133).fixed32(769);
}