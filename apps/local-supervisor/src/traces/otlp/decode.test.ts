import assert from 'node:assert/strict';
import test from 'node:test';
import { Writer } from 'protobufjs';

import { decodeOtlp } from './decode';
import { binaryRequest, jsonRequest, jsonSpan, message, wireRequest, wireSpan } from './fixtures.test';

test('official OTLP field numbers decode from a public protobuf writer with exact nanos and all AnyValue variants', () => {
	const decoded = decodeOtlp(wireRequest(wireSpan()), 'protobuf');
	assert.deepEqual(decoded.resourceSpans?.[0]?.scopeSpans?.[0]?.spans?.[0], jsonSpan());
	assert.equal(decoded.resourceSpans?.[0]?.resource?.attributes?.[0]?.value?.stringValue, 'otlp-test');
	assert.equal(decoded.resourceSpans?.[0]?.scopeSpans?.[0]?.scope?.name, 'test.instrumentation');
	assert.deepEqual(decodeOtlp(Buffer.from(JSON.stringify(jsonRequest())), 'json'), jsonRequest());
});

test('OTLP JSON validates known fields without coercion and ignores bounded unknown fields', () => {
	const decode = (span: unknown): unknown => decodeOtlp(Buffer.from(JSON.stringify({ resourceSpans: [{ scopeSpans: [{ spans: [span] }] }] })), 'json');
	for (const overrides of [
		{ traceId: '0'.repeat(32) }, { spanId: '0'.repeat(16) }, { parentSpanId: '0'.repeat(16) }, { traceId: 'abc' },
		{ startTimeUnixNano: 1791849600123456789 }, { endTimeUnixNano: '18446744073709551616' },
		{ startTimeUnixNano: '-1' }, { endTimeUnixNano: '12.5' }, { kind: 'SPAN_KIND_CLIENT' }, { flags: -1 },
		{ attributes: {} }, { events: [null] }, { status: { code: 'STATUS_CODE_ERROR' } },
		{ attributes: [{ key: 'bad', value: { intValue: '9223372036854775808' } }] },
		{ attributes: [{ key: 'bad', value: { boolValue: 'false' } }] },
		{ attributes: [{ key: 'bad', value: { bytesValue: '???' } }] },
		{ attributes: [{ key: 'bad', value: { stringValue: 'one', intValue: '2' } }] },
	]) { assert.throws(() => decode({ ...jsonSpan(), ...overrides }), { status: 400 }); }
	assert.doesNotThrow(() => decode({ ...jsonSpan(), traceId: jsonSpan().traceId!.toUpperCase(), futureField: { version: 2 } }));
	assert.throws(() => decodeOtlp(Buffer.from('{"__proto__":{"exposed":true}}'), 'json'), { status: 400 });
});

test('protobuf rejects truncated frames, wrong wire types, overflowing varints and duplicate oneofs before decoding', () => {
	for (const payload of [Buffer.from([10, 255]), Buffer.from([11]), Buffer.from([0]), wireRequest(Writer.create().uint32(8).uint32(1)),
		wireRequest(wireSpan().uint32(48).int32(1)), wireRequest(wireSpan().uint32(80).uint64('4294967296'))]) {
		assert.throws(() => decodeOtlp(payload, 'protobuf'), { status: 400 });
	}
	const ambiguous = message(wireSpan(), 9, message(Writer.create().uint32(10).string('bad'), 2, Writer.create().uint32(10).string('text').uint32(24).int64(2)));
	assert.throws(() => decodeOtlp(wireRequest(ambiguous), 'protobuf'), { status: 400 });
	const malformedUtf8 = message(wireSpan(), 9, message(Writer.create().uint32(10).string('bad'), 2, Writer.create().uint32(10).bytes(Buffer.from([255]))));
	assert.throws(() => decodeOtlp(wireRequest(malformedUtf8), 'protobuf'), { status: 400 });
	assert.doesNotThrow(() => decodeOtlp(wireRequest(wireSpan().uint32(160).uint32(1)), 'protobuf'));
});

test('JSON and protobuf recursive values and oversized collections are bounded before recursive decoding', () => {
	let nested = Writer.create().uint32(10).string('leaf').finish();
	for (let index = 0; index < 100; index += 1) { nested = message(Writer.create(), 5, message(Writer.create(), 1, nested)).finish(); }
	const span = message(wireSpan(), 9, message(Writer.create().uint32(10).string('deep'), 2, nested));
	assert.throws(() => decodeOtlp(wireRequest(span), 'protobuf'), { status: 400 });
	assert.throws(() => decodeOtlp(Buffer.from(`${'['.repeat(10_000)}0${']'.repeat(10_000)}`), 'json'), { status: 400 });
	assert.throws(() => decodeOtlp(Buffer.from(JSON.stringify(jsonRequest(Array.from({ length: 101 }, () => jsonSpan())))), 'json'), { status: 400 });
});

test('known malformed attributes are rejected even in empty resource and scope envelopes', () => {
	for (const attributes of [[{ key: '', value: {} }], [{ key: '__proto__', value: {} }], [{ key: 'duplicate', value: {} }, { key: 'duplicate', value: {} }]]) {
		for (const empty of [{ resource: { attributes } }, { scopeSpans: [{ scope: { attributes } }] }]) {
			const input = jsonRequest();
			input.resourceSpans!.push(empty);
			assert.throws(() => decodeOtlp(Buffer.from(JSON.stringify(input)), 'json'), { status: 400 });
			assert.throws(() => decodeOtlp(binaryRequest(input), 'protobuf'), { status: 400 });
		}
	}
});