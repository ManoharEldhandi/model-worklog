import { z } from 'zod';

import type { JsonObject, JsonValue } from './events';
import type { CaptureReport } from './trace';

export const PrivacyPolicySchema = z.strictObject({
	mode: z.enum(['metadata', 'redacted-content']).default('metadata'),
	allowedAttributeKeys: z.array(z.string().min(1).max(256)).max(128).default([]),
	excludedKeys: z.array(z.string().min(1).max(256)).max(128).default([]),
	maxStringLength: z.number().int().min(16).max(16_000).default(4_000),
});
export type PrivacyPolicy = z.infer<typeof PrivacyPolicySchema>;
export type PrivacyOptions = z.input<typeof PrivacyPolicySchema>;

const forbidden = /(?:^|\.)(?:__proto__|constructor|prototype|thinking|reasoning|reasoning_content|reasoning_text|reasoning_details|chain[_-]?of[_-]?thought|scratchpad|encrypted_content)(?:\.|$)/i;
const secretKey = /authorization|cookie|password|secret|private.?key|api.?key|(?:access|refresh|id|bearer).?token|credential|^token$/i;
const metadataKey = /^(?:gen_ai\.(?:system|provider\.name|request\.model|response\.(?:model|id)|usage\.[a-z_.]+)|tool\.(?:name|server(?:\.name)?)|mcp\.(?:method|server\.name)|db\.system|http\.(?:request\.method|response\.status_code)|error\.type|code\.(?:function|namespace))$/;

export function redactSensitiveText(input: string): string {
	return input
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
		.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
		.replace(/\b(?:gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|sk-[\w-]{20,}|npm_[\w]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
		.replace(/((?:api[_-]?key|token|password|secret|authorization)\s*[=:]\s*)[^\s,;"']+/gi, '$1[REDACTED]');
}

export function redactAttributes(input: unknown, options: PrivacyOptions = {}): { attributes: JsonObject; report: CaptureReport } {
	const policy = PrivacyPolicySchema.parse(options);
	let redactedFields = 0;
	let truncatedFields = 0;
	let nodes = 0;
	const seen = new WeakSet<object>();
	const sanitize = (value: unknown, depth: number): JsonValue => {
		if (++nodes > 10_000 || depth > 12) { truncatedFields += 1; return '[TRUNCATED]'; }
		if (value === null || typeof value === 'boolean') { return value; }
		if (typeof value === 'number' && Number.isFinite(value)) { return value; }
		if (typeof value === 'string') {
			const clean = redactSensitiveText(value);
			if (clean !== value) { redactedFields += 1; }
			if (clean.length > policy.maxStringLength) { truncatedFields += 1; return `${clean.slice(0, policy.maxStringLength - 12)}[TRUNCATED]`; }
			return clean;
		}
		if (typeof value !== 'object' || seen.has(value)) { truncatedFields += 1; return '[UNSUPPORTED]'; }
		seen.add(value);
		if (Array.isArray(value)) {
			if (value.length > 128) { truncatedFields += 1; }
			return value.slice(0, 128).map((entry) => sanitize(entry, depth + 1));
		}
		if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) { truncatedFields += 1; return '[UNSUPPORTED]'; }
		const contentType = Object.getOwnPropertyDescriptor(value, 'type');
		if (contentType !== undefined && 'value' in contentType && typeof contentType.value === 'string'
			&& /^(?:thinking|reasoning|redacted_thinking|thinking_delta|reasoning_delta|reasoning\.text(?:\.delta)?|response\.reasoning_text\.delta)$/i.test(contentType.value)) {
			redactedFields += 1;
			return '[REASONING NOT CAPTURED]';
		}
		const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
		const descriptors = Object.entries(Object.getOwnPropertyDescriptors(value));
		if (descriptors.length > 128) { truncatedFields += 1; }
		for (const [key, descriptor] of descriptors.slice(0, 128)) {
			if (key.length > 256 || forbidden.test(key) || policy.excludedKeys.includes(key) || !('value' in descriptor)) { redactedFields += 1; continue; }
			if (secretKey.test(key)) { output[key] = '[REDACTED]'; if (descriptor.value !== '[REDACTED]') { redactedFields += 1; } continue; }
			const cleanKey = redactSensitiveText(key);
			output[cleanKey] = sanitize(descriptor.value as unknown, depth + 1);
		}
		return output;
	};
	let attributes: JsonObject = {};
	if (typeof input === 'object' && input !== null && !Array.isArray(input)) {
		const selected: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
		const entries = Object.entries(Object.getOwnPropertyDescriptors(input));
		if (entries.length > 128) { truncatedFields += 1; }
		for (const [key, descriptor] of entries.slice(0, 128)) {
			if (!('value' in descriptor) || (policy.mode === 'metadata' && !metadataKey.test(key) && !policy.allowedAttributeKeys.includes(key))) { redactedFields += 1; continue; }
			selected[key] = descriptor.value as unknown;
		}
		attributes = sanitize(selected, 0) as JsonObject;
	}
	return { attributes, report: { mode: policy.mode, redactedFields, truncatedFields, droppedEvents: 0, limitations: ['Provider-hidden reasoning is not collected.'] } };
}