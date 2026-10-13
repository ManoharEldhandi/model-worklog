import { Enum, Reader, Type } from 'protobufjs';

import { TraceError } from '../domain/contracts';
import { exportTraceRequest, type OtlpEncoding, type OtlpRequest } from './protocol';
import { boundedJson, invalidOtlp, MAX_OTLP_DEPTH, MAX_OTLP_NODES, repeatedLimit, validateMessage } from './validation';

function checkWire(payload: Buffer): void {
	const reader = Reader.create(payload);
	const utf8 = new TextDecoder('utf-8', { fatal: true });
	let nodes = 0;
	let spans = 0;
	const unsigned = (): bigint => {
		const start = reader.pos;
		const value = BigInt(reader.uint64().toString());
		if (reader.pos - start === 10 && payload[reader.pos - 1]! > 1) { invalidOtlp(); }
		return value;
	};
	const skip = (size: number, end: number): void => {
		if (size > end - reader.pos) { invalidOtlp(); }
		reader.skip(size);
	};
	const visit = (message: Type, end: number, depth: number): void => {
		if (depth > MAX_OTLP_DEPTH || (message.name === 'Span' && ++spans > 100)) { invalidOtlp(); }
		const counts = new Map<number, number>();
		const oneofs = new Set<string>();
		while (reader.pos < end) {
			if (++nodes > MAX_OTLP_NODES) { invalidOtlp(); }
			const rawTag = unsigned();
			if (rawTag > 0xffff_ffffn || rawTag < 8n) { invalidOtlp(); }
			const tag = Number(rawTag);
			const wireType = tag & 7;
			const field = message.fieldsById[tag >>> 3];
			if (field !== undefined) {
				const expected = field.resolvedType instanceof Type || field.type === 'string' || field.type === 'bytes' ? 2
					: field.type === 'fixed64' || field.type === 'double' ? 1 : field.type === 'fixed32' ? 5 : 0;
				if (wireType !== expected) { invalidOtlp(); }
				const count = (counts.get(field.id) ?? 0) + 1;
				if (count > (field.repeated ? repeatedLimit(field) : 1)) { invalidOtlp(); }
				counts.set(field.id, count);
				if (field.partOf !== null) {
					if (oneofs.has(field.partOf.name)) { invalidOtlp(); }
					oneofs.add(field.partOf.name);
				}
			}
			switch (wireType) {
				case 0: {
					const value = unsigned();
					if ((field?.type === 'uint32' && value > 0xffff_ffffn) || (field?.type === 'bool' && value > 1n)
						|| (field?.resolvedType instanceof Enum && value > 0x7fff_ffffn)) { invalidOtlp(); }
					break;
				}
				case 1: skip(8, end); break;
				case 2: {
					const length = unsigned();
					if (length > BigInt(end - reader.pos)) { invalidOtlp(); }
					const stop = reader.pos + Number(length);
					if (field?.resolvedType instanceof Type) { visit(field.resolvedType, stop, depth + 1); }
					else {
						if (field?.type === 'string' && utf8.decode(payload.subarray(reader.pos, stop)).length > 16_000) { invalidOtlp(); }
						skip(Number(length), end);
					}
					break;
				}
				case 5: skip(4, end); break;
				default: invalidOtlp();
			}
			if (reader.pos > end) { invalidOtlp(); }
		}
	};
	visit(exportTraceRequest, payload.length, 0);
}

export function decodeOtlp(payload: Buffer, encoding: OtlpEncoding): OtlpRequest {
	try {
		let input: unknown;
		if (encoding === 'json') { input = boundedJson(new TextDecoder('utf-8', { fatal: true }).decode(payload)); }
		else {
			checkWire(payload);
			input = exportTraceRequest.toObject(exportTraceRequest.decode(payload), { longs: String });
		}
		return validateMessage(input, exportTraceRequest, encoding) as OtlpRequest;
	} catch (error) {
		if (error instanceof TraceError) { throw error; }
		return invalidOtlp();
	}
}