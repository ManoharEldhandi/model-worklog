import {
	PrivacyPolicySchema, TraceSpanSchema, redactAttributes, redactSensitiveText,
	type CaptureReport, type PrivacyOptions, type TraceSpan,
} from 'model-worklog-schema';

export function sanitizeSpan(span: TraceSpan, options: PrivacyOptions): TraceSpan {
	const operator = PrivacyPolicySchema.parse(options);
	const mode = operator.mode === 'redacted-content' && span.capture.mode === 'redacted-content' ? 'redacted-content' : 'metadata';
	const policy: PrivacyOptions = { ...operator, mode };
	let redactedFields = span.capture.redactedFields;
	let truncatedFields = span.capture.truncatedFields;
	const addReport = (report: CaptureReport): void => {
		redactedFields = Math.min(Number.MAX_SAFE_INTEGER, redactedFields + report.redactedFields);
		truncatedFields = Math.min(Number.MAX_SAFE_INTEGER, truncatedFields + report.truncatedFields);
	};
	const label = (value: string, maximum: number): string => {
		const clean = redactSensitiveText(value);
		if (clean !== value) { redactedFields = Math.min(Number.MAX_SAFE_INTEGER, redactedFields + 1); }
		const length = Math.min(maximum, operator.maxStringLength);
		if (clean.length > length) { truncatedFields = Math.min(Number.MAX_SAFE_INTEGER, truncatedFields + 1); }
		return clean.slice(0, length);
	};
	const attributes = redactAttributes(span.attributes, policy);
	addReport(attributes.report);
	const name = label(span.name, 256);
	const serviceName = label(span.serviceName, 128);
	const events = span.events.map((event) => {
		const clean = redactAttributes(event.attributes, policy);
		addReport(clean.report);
		return { ...event, name: label(event.name, 256), attributes: clean.attributes };
	});
	const usage = span.usage === undefined ? undefined : {
		...span.usage,
		...(span.usage.provider === undefined ? {} : { provider: label(span.usage.provider, 128) }),
		...(span.usage.model === undefined ? {} : { model: label(span.usage.model, 128) }),
		...(span.usage.requestId === undefined ? {} : { requestId: label(span.usage.requestId, 256) }),
	};
	const limitations = [...new Set(span.capture.limitations.map((value) => label(value, 256)))];
	return TraceSpanSchema.parse({
		...span, name, serviceName, attributes: attributes.attributes, events, usage,
		capture: { mode, redactedFields, truncatedFields, droppedEvents: span.capture.droppedEvents, limitations },
	});
}