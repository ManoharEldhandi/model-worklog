import { redactAttributes, redactSensitiveText, type JsonValue, type StoredTraceSpan } from 'model-worklog-schema';

export const INTEGRATION_SCOPE = 'Supported agent hooks and instrumented applications only; coverage depends on integration.';
export const TRACE_CAPTURE_SCOPE = 'SDK spans received by the supervisor, not a complete record of underlying execution.';

export function traceText(value: string): string {
	return redactSensitiveText(value.replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => {
		try {
			const url = new URL(candidate);
			if (url.username || url.password || [...url.searchParams.keys()].some((key) => /token|key|auth|signature|credential|password|secret/i.test(key))) {
				return '[REDACTED URL]';
			}
		} catch { return '[INVALID URL]'; }
		return candidate;
	}));
}

function publicJson(value: JsonValue): JsonValue {
	if (typeof value === 'string') { return traceText(value); }
	if (Array.isArray(value)) { return value.map(publicJson); }
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [traceText(key), publicJson(item)]));
	}
	return value;
}

export function publicStoredSpan(stored: StoredTraceSpan): StoredTraceSpan {
	const span = stored.span;
	const attributes = (input: typeof span.attributes): typeof span.attributes => {
		const redacted = redactAttributes(input, { mode: 'redacted-content', maxStringLength: 16_000 }).attributes;
		return Object.fromEntries(Object.entries(redacted).map(([key, value]) => [traceText(key), publicJson(value)]));
	};
	return {
		...stored,
		span: {
			...span, name: traceText(span.name), serviceName: traceText(span.serviceName), attributes: attributes(span.attributes),
			events: span.events.map((event) => ({ ...event, name: traceText(event.name), attributes: attributes(event.attributes) })),
			capture: { ...span.capture, limitations: span.capture.limitations.map(traceText) },
			...(span.usage === undefined ? {} : { usage: {
				...span.usage,
				...(span.usage.provider === undefined ? {} : { provider: traceText(span.usage.provider) }),
				...(span.usage.model === undefined ? {} : { model: traceText(span.usage.model) }),
				...(span.usage.requestId === undefined ? {} : { requestId: traceText(span.usage.requestId) }),
			} }),
		},
	};
}