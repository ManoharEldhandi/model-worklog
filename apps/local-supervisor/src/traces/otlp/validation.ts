import { Enum, Type, type Field } from 'protobufjs';

import { TraceError } from '../domain/contracts';
import type { OtlpEncoding } from './protocol';

export const MAX_OTLP_DEPTH = 48;
export const MAX_OTLP_NODES = 100_000;
const unsafeKeys = new Set(['__proto__', 'constructor', 'prototype']);

export function invalidOtlp(): never {
	throw new TraceError(400, 'invalid_otlp', 'Expected bounded OTLP trace data with valid fields, identifiers and exact integers.');
}

export function repeatedLimit(field: Field): number {
	if (['resourceSpans', 'scopeSpans', 'spans'].includes(field.name)) { return 100; }
	return field.parent?.name === 'ArrayValue' ? 1_000 : 128;
}

export function boundedJson(input: string): unknown {
	const parsed: unknown = JSON.parse(input);
	const pending = [{ value: parsed, depth: 0 }];
	let nodes = 0;
	while (pending.length > 0) {
		const entry = pending.pop()!;
		if (++nodes > MAX_OTLP_NODES || entry.depth > MAX_OTLP_DEPTH) { invalidOtlp(); }
		if (typeof entry.value === 'string' && entry.value.length > 16_000) { invalidOtlp(); }
		if (typeof entry.value === 'number' && !Number.isFinite(entry.value)) { invalidOtlp(); }
		if (entry.value === null || typeof entry.value !== 'object') { continue; }
		const entries = Object.entries(entry.value);
		if (entries.length > (Array.isArray(entry.value) ? 1_000 : 128)) { invalidOtlp(); }
		for (const [key, value] of entries) {
			if (unsafeKeys.has(key) || key.length > 256) { invalidOtlp(); }
			pending.push({ value: value as unknown, depth: entry.depth + 1 });
		}
	}
	return parsed;
}

function integer(value: unknown, signed: boolean, bits: number): string {
	if (typeof value === 'number' && !Number.isSafeInteger(value)) { invalidOtlp(); }
	if ((typeof value !== 'string' && typeof value !== 'number') || !/^-?(?:0|[1-9][0-9]{0,19})$/.test(String(value))) { invalidOtlp(); }
	const exact = BigInt(value);
	const width = BigInt(bits);
	if (exact < (signed ? -(1n << (width - 1n)) : 0n) || exact >= (1n << (signed ? width - 1n : width))) { invalidOtlp(); }
	return exact.toString();
}

function bytes(value: unknown, field: Field, encoding: OtlpEncoding): string {
	const identifier = ['traceId', 'spanId', 'parentSpanId'].includes(field.name);
	let encoded: string;
	if (encoding === 'protobuf') {
		if (!(value instanceof Uint8Array)) { invalidOtlp(); }
		encoded = Buffer.from(value).toString(identifier ? 'hex' : 'base64');
	} else {
		if (typeof value !== 'string') { invalidOtlp(); }
		encoded = value;
	}
	if (identifier) {
		if (field.name === 'parentSpanId' && encoded === '') { return ''; }
		const length = field.name === 'traceId' ? 32 : 16;
		if (encoded.length !== length || !/^[a-f0-9]+$/i.test(encoded) || /^0+$/.test(encoded)) { invalidOtlp(); }
		return encoded.toLowerCase();
	}
	if (encoded.length > 16_000 || !/^[A-Za-z0-9+/_-]*={0,2}$/.test(encoded)) { invalidOtlp(); }
	const canonical = Buffer.from(encoded, 'base64').toString('base64');
	if (canonical.replace(/=+$/, '') !== encoded.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')) { invalidOtlp(); }
	return canonical;
}

function scalar(value: unknown, field: Field, encoding: OtlpEncoding): unknown {
	if (field.resolvedType instanceof Enum) {
		if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2_147_483_647) { invalidOtlp(); }
		return value;
	}
	switch (field.type) {
		case 'string':
			if (typeof value !== 'string' || value.length > 16_000) { invalidOtlp(); }
			return value;
		case 'bool':
			if (typeof value !== 'boolean') { invalidOtlp(); }
			return value;
		case 'bytes': return bytes(value, field, encoding);
		case 'int64': return integer(value, true, 64);
		case 'fixed64': return integer(value, false, 64);
		case 'uint32': case 'fixed32': return Number(integer(value, false, 32));
		case 'double':
			if (typeof value === 'number') { return Number.isFinite(value) ? value : String(value); }
			if (value === 'NaN' || value === 'Infinity' || value === '-Infinity') { return value; }
			invalidOtlp();
		default: return invalidOtlp();
	}
}

export function validateMessage(input: unknown, type: Type, encoding: OtlpEncoding): Record<string, unknown> {
	let nodes = 0;
	let spans = 0;
	const visit = (value: unknown, message: Type, depth: number): Record<string, unknown> => {
		if (++nodes > MAX_OTLP_NODES || depth > MAX_OTLP_DEPTH || value === null || typeof value !== 'object' || Array.isArray(value)) { invalidOtlp(); }
		if (message.name === 'Span' && ++spans > 100) { invalidOtlp(); }
		const output: Record<string, unknown> = {};
		const oneofs = new Set<string>();
		for (const [key, entry] of Object.entries(value)) {
			if (unsafeKeys.has(key)) { invalidOtlp(); }
			const field = Object.hasOwn(message.fields, key) ? message.fields[key] : undefined;
			if (field === undefined || entry === null || entry === undefined) { continue; }
			if (field.partOf !== null) {
				if (oneofs.has(field.partOf.name)) { invalidOtlp(); }
				oneofs.add(field.partOf.name);
			}
			const normalize = (element: unknown): unknown => {
				if (++nodes > MAX_OTLP_NODES) { invalidOtlp(); }
				return field.resolvedType instanceof Type ? visit(element, field.resolvedType, depth + 1) : scalar(element, field, encoding);
			};
			if (field.repeated) {
				if (!Array.isArray(entry) || entry.length > repeatedLimit(field)) { invalidOtlp(); }
				const normalized = entry.map(normalize);
				if (field.resolvedType instanceof Type && field.resolvedType.name === 'KeyValue'
					&& new Set(normalized.map((element) => (element as { key: string }).key)).size !== normalized.length) { invalidOtlp(); }
				output[key] = normalized;
			} else { output[key] = normalize(entry); }
		}
		if (message.name === 'KeyValue' && (typeof output.key !== 'string' || output.key.length === 0 || output.key.length > 256 || unsafeKeys.has(output.key))) { invalidOtlp(); }
		return output;
	};
	return visit(input, type, 0);
}