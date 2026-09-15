import type { JsonObject, JsonValue } from 'model-worklog-schema';

export const REDACTION_POLICY_VERSION = '1' as const;
export const REDACTED_VALUE = '[REDACTED]' as const;

export interface RedactionResult<T> {
	readonly value: T;
	readonly replacements: number;
}

const SECRET_PATTERNS: readonly RegExp[] = [
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
	/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[abopr]-[A-Za-z0-9-]{20,}|npm_[A-Za-z0-9]{20,})\b/g,
	/(\b(?:api[_-]?key|access[_-]?token|authorization|password|secret|token)\b["']?\s*[:=]\s*["']?)([^\s,"'}\]]+)/gi,
];

const SENSITIVE_KEY = /(?:^|[_-])(api[_-]?key|access[_-]?token|authorization|password|secret|token|private[_-]?key|client[_-]?secret|refresh[_-]?token|id[_-]?token|cookie)(?:$|[_-])/i;

export function redactText(input: string): RedactionResult<string> {
	let replacements = 0;
	let value = input;
	for (const pattern of SECRET_PATTERNS) {
		value = value.replace(pattern, (match: string, prefix?: string) => {
			replacements += 1;
			return prefix === undefined ? REDACTED_VALUE : `${prefix}${REDACTED_VALUE}`;
		});
	}
	return { value, replacements };
}

export function redactJson(value: JsonValue): RedactionResult<JsonValue> {
	if (typeof value === 'string') {
		return redactText(value);
	}
	if (value === null || typeof value === 'number' || typeof value === 'boolean') {
		return { value, replacements: 0 };
	}
	if (Array.isArray(value)) {
		let replacements = 0;
		const entries = value.map((entry) => {
			const redacted = redactJson(entry);
			replacements += redacted.replacements;
			return redacted.value;
		});
		return { value: entries, replacements };
	}

	let replacements = 0;
	const output: Record<string, JsonValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		const redactedKey = redactText(key);
		const redactedValue = SENSITIVE_KEY.test(key) ? { value: REDACTED_VALUE, replacements: 1 } : redactJson(entry);
		replacements += redactedKey.replacements + redactedValue.replacements;
		output[redactedKey.value] = redactedValue.value;
	}
	return { value: output as JsonObject, replacements };
}