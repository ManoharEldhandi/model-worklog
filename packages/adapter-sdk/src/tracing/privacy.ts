import {
	PrivacyPolicySchema, SpanLinkSchema, SpanUsageSchema, TraceAttributesSchema, TraceSpanSchema,
	redactAttributes, redactSensitiveText,
	type CaptureReport, type JsonObject, type JsonValue, type PrivacyOptions, type PrivacyPolicy, type SpanUsage, type TraceSpan,
} from 'model-worklog-schema';

export const OTEL_START_LIMITATION = 'OpenTelemetry start snapshot reconstructed from a completed span.';

export interface TraceLimits {
	readonly maxSpanBytes?: number;
	readonly maxAttributeBytes?: number;
	readonly maxEvents?: number;
}

export interface CaptureSettings {
	readonly policy: PrivacyPolicy;
	readonly maxSpanBytes: number;
	readonly maxAttributeBytes: number;
	readonly maxEvents: number;
}

export function integerOption(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
	const result = value ?? fallback;
	if (!Number.isInteger(result) || result < minimum || result > maximum) { throw new Error('Invalid tracing limit.'); }
	return result;
}

export function captureSettings(privacy: PrivacyOptions = {}, limits: TraceLimits = {}): CaptureSettings {
	return Object.freeze({
		policy: freeze(PrivacyPolicySchema.parse(privacy)),
		maxSpanBytes: integerOption(limits.maxSpanBytes, 65_536, 2_048, 1_048_576),
		maxAttributeBytes: integerOption(limits.maxAttributeBytes, 16_384, 256, 262_144),
		maxEvents: integerOption(limits.maxEvents, 64, 0, 128),
	});
}

export function freeze<Value>(value: Value): Value {
	if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
		for (const child of Object.values(value)) { freeze(child); }
		Object.freeze(value);
	}
	return value;
}

export function label(value: string, maximum: number, fallback: string): string {
	return redactSensitiveText(value).slice(0, maximum).trim() || fallback;
}

export function emptyReport(settings: CaptureSettings): CaptureReport {
	return { mode: settings.policy.mode, redactedFields: 0, truncatedFields: 0, droppedEvents: 0, limitations: ['Provider-hidden reasoning is not collected.'] };
}

export function mergeReport(target: CaptureReport, report: CaptureReport): void {
	target.redactedFields = Math.min(Number.MAX_SAFE_INTEGER, target.redactedFields + report.redactedFields);
	target.truncatedFields = Math.min(Number.MAX_SAFE_INTEGER, target.truncatedFields + report.truncatedFields);
	target.droppedEvents = Math.min(Number.MAX_SAFE_INTEGER, target.droppedEvents + report.droppedEvents);
}

function removeReasoning(value: JsonValue, report: CaptureReport): void {
	if (typeof value !== 'object' || value === null) { return; }
	for (const [key, child] of Object.entries(value)) {
		if (/(?:^|\.)(?:thinking|reasoning|reasoning_content|reasoning_text|chain[_-]?of[_-]?thought|scratchpad|encrypted_content)(?:\.|$)/i.test(key)) {
			delete (value as Record<string, JsonValue>)[key];
			report.redactedFields += 1;
		} else { removeReasoning(child, report); }
	}
}

export function safeAttributes(input: unknown, settings: CaptureSettings): { attributes: JsonObject; report: CaptureReport } {
	const result = redactAttributes(input, settings.policy);
	removeReasoning(result.attributes, result.report);
	let bytes = 2;
	for (const [key, value] of Object.entries(result.attributes)) {
		const size = Buffer.byteLength(JSON.stringify({ [key]: value }));
		if (key.length === 0 || bytes + size > settings.maxAttributeBytes) {
			delete (result.attributes as Record<string, JsonValue>)[key];
			result.report.truncatedFields += 1;
		} else { bytes += size; }
	}
	result.attributes = TraceAttributesSchema.parse(result.attributes);
	return result;
}

export function safeUsage(input: SpanUsage | undefined): SpanUsage | undefined {
	if (input === undefined) { return undefined; }
	return SpanUsageSchema.parse({
		...input,
		...(input.provider === undefined ? {} : { provider: label(input.provider, 128, 'unknown') }),
		...(input.model === undefined ? {} : { model: label(input.model, 128, 'unknown') }),
		...(input.requestId === undefined ? {} : { requestId: label(input.requestId, 256, 'redacted') }),
	});
}

export function prepareSnapshot(input: TraceSpan, settings: CaptureSettings): TraceSpan {
	const effective = input.capture.mode === 'metadata' && settings.policy.mode === 'redacted-content'
		? { ...settings, policy: { ...settings.policy, mode: 'metadata' as const } }
		: settings;
	const capture = emptyReport(effective);
	mergeReport(capture, input.capture);
	if (input.capture.limitations.includes(OTEL_START_LIMITATION)) { capture.limitations.push(OTEL_START_LIMITATION); }
	const attributes = safeAttributes(input.attributes, effective);
	mergeReport(capture, attributes.report);
	const events = input.events.slice(0, settings.maxEvents).map((event) => {
		const clean = safeAttributes(event.attributes, effective);
		mergeReport(capture, clean.report);
		return { name: label(event.name, 256, 'event'), at: event.at, attributes: clean.attributes };
	});
	capture.droppedEvents += input.events.length - events.length;
	const snapshot = TraceSpanSchema.parse({
		...input, name: label(input.name, 256, 'span'), serviceName: label(input.serviceName, 128, 'service'),
		attributes: attributes.attributes, events, links: input.links.slice(0, 128).map((link) => SpanLinkSchema.parse(link)),
		usage: safeUsage(input.usage), capture,
	});
	const oversized = (): boolean => Buffer.byteLength(JSON.stringify(snapshot)) > settings.maxSpanBytes;
	while (oversized() && snapshot.events.length > 0) { snapshot.events.pop(); snapshot.capture.droppedEvents += 1; }
	for (const key of Object.keys(snapshot.attributes).reverse()) {
		if (!oversized()) { break; }
		delete snapshot.attributes[key];
		snapshot.capture.truncatedFields += 1;
	}
	while (oversized() && snapshot.links.length > 0) { snapshot.links.pop(); snapshot.capture.truncatedFields += 1; }
	if (oversized()) { throw new Error('Trace snapshot exceeds payload limit.'); }
	return freeze(snapshot);
}