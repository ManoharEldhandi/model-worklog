import { isBoundedJson, type CaptureReport, type JsonObject, type JsonValue } from 'model-worklog-schema';

import type { AnyValue, KeyValue } from './protocol';
import { boundedJson, invalidOtlp } from './validation';

const reasoning = /(?:^|[._\s-])(?:reasoning|thinking|scratchpad|chain[._\s-]*of[._\s-]*thought|encrypted[._\s-]*content)(?:$|[._\s-])/i;
const serializedContent = /^(?:gen_ai\.(?:(?:input|output)\.messages|system_instructions|prompt|completion)|llm\.(?:input|output)_messages|(?:input|output)\.value)$/;

export function limitation(report: CaptureReport, message: string): void {
	if (!report.limitations.includes(message)) { report.limitations.push(message); }
}

function value(input: AnyValue, report: CaptureReport, depth: number): JsonValue {
	if (depth > 16) { invalidOtlp(); }
	if (input.stringValue !== undefined) { return input.stringValue; }
	if (input.boolValue !== undefined) { return input.boolValue; }
	if (input.intValue !== undefined) {
		const numeric = Number(input.intValue);
		if (Number.isSafeInteger(numeric)) { return numeric; }
		limitation(report, 'OTLP integers outside the JavaScript safe range are retained as decimal strings.');
		return input.intValue;
	}
	if (input.doubleValue !== undefined) {
		if (typeof input.doubleValue === 'string') { limitation(report, 'Non-finite OTLP doubles are retained as strings.'); }
		return input.doubleValue;
	}
	if (input.bytesValue !== undefined) {
		limitation(report, 'OTLP bytes attributes are retained as base64 strings.');
		return input.bytesValue;
	}
	if (input.arrayValue !== undefined) { return (input.arrayValue.values ?? []).map((entry) => value(entry, report, depth + 1)); }
	if (input.kvlistValue !== undefined) { return pairs(input.kvlistValue.values ?? [], report, depth + 1); }
	return null;
}

function pairs(input: KeyValue[], report: CaptureReport, depth: number): JsonObject {
	if (depth > 16) { invalidOtlp(); }
	const output: Record<string, JsonValue> = {};
	for (const entry of input) {
		const key = entry.key;
		if (key === undefined || key.length === 0 || key.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(output, key)) { invalidOtlp(); }
		output[key] = value(entry.value ?? {}, report, depth);
	}
	return output;
}

export function attributes(input: KeyValue[] | undefined, report: CaptureReport): JsonObject {
	const output = pairs(input ?? [], report, 0);
	if (!isBoundedJson(output)) { invalidOtlp(); }
	return output;
}

export function isReasoning(input: JsonValue): boolean {
	if (typeof input === 'string') { return reasoning.test(input); }
	if (input === null || typeof input !== 'object' || Array.isArray(input)) { return false; }
	return (typeof input.type === 'string' && reasoning.test(input.type)) || (typeof input.kind === 'string' && reasoning.test(input.kind));
}

export function withoutReasoning(input: JsonValue, report: CaptureReport, key = ''): JsonValue | undefined {
	const drop = (): undefined => { report.redactedFields += 1; return undefined; };
	const tokenCount = /^(?:gen_ai\.usage\.|llm\.token_count\.)/.test(key) && typeof input === 'number' && Number.isSafeInteger(input) && input >= 0;
	if (reasoning.test(key) && !tokenCount) { return drop(); }
	if (typeof input === 'string' && serializedContent.test(key) && /^[\s]*[\[{]/.test(input)) {
		let parsed: unknown;
		try { parsed = boundedJson(input); }
		catch (error) { if (error instanceof SyntaxError) { return input; } throw error; }
		if (!isBoundedJson(parsed)) { invalidOtlp(); }
		const clean = withoutReasoning(parsed, report);
		return clean === undefined ? undefined : JSON.stringify(clean);
	}
	if (input === null || typeof input !== 'object') { return input; }
	if (Array.isArray(input)) {
		return input.flatMap((entry) => { const clean = withoutReasoning(entry, report); return clean === undefined ? [] : [clean]; });
	}
	if (isReasoning(input)) { return drop(); }
	const blocked = Object.entries(input).filter(([name, entry]) => /\.(?:type|kind)$/.test(name) && typeof entry === 'string' && isReasoning(entry))
		.map(([name]) => name.slice(0, name.lastIndexOf('.')));
	const output: Record<string, JsonValue> = {};
	for (const [name, entry] of Object.entries(input)) {
		if (blocked.some((prefix) => name === prefix || name.startsWith(`${prefix}.`))) { drop(); continue; }
		const clean = withoutReasoning(entry, report, name);
		if (clean !== undefined) { output[name] = clean; }
	}
	return output;
}