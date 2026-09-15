export interface ParseIssue {
	readonly path: string;
	readonly message: string;
}

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly issues: readonly ParseIssue[] };

export function ok<T>(value: T): ParseResult<T> {
	return { ok: true, value };
}

export function err(path: string, message: string): ParseResult<never> {
	return { ok: false, issues: [{ path, message }] };
}

export function errs(issues: readonly ParseIssue[]): ParseResult<never> {
	return { ok: false, issues };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function describe(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	return typeof value;
}

function pathAt(parent: string, key: string): string {
	return parent === '' ? key : `${parent}.${key}`;
}

export function requireNonEmptyString(input: Record<string, unknown>, key: string, parent: string): ParseResult<string> {
	const value = input[key];
	const path = pathAt(parent, key);
	if (typeof value !== 'string') {
		return err(path, `expected string, received ${describe(value)}`);
	}
	return value.trim() === '' ? err(path, 'expected non-empty string') : ok(value);
}

export function requireInteger(input: Record<string, unknown>, key: string, parent: string): ParseResult<number> {
	const value = input[key];
	const path = pathAt(parent, key);
	return typeof value === 'number' && Number.isInteger(value)
		? ok(value)
		: err(path, `expected integer, received ${describe(value)}`);
}

export function requireEnum<T extends readonly string[]>(input: Record<string, unknown>, key: string, parent: string, values: T): ParseResult<T[number]> {
	const value = input[key];
	const path = pathAt(parent, key);
	return typeof value === 'string' && (values as readonly string[]).includes(value)
		? ok(value as T[number])
		: err(path, `expected one of ${values.join(', ')}, received ${describe(value)}`);
}

export function requireRecord(input: Record<string, unknown>, key: string, parent: string): ParseResult<Record<string, unknown>> {
	const value = input[key];
	return isRecord(value)
		? ok(value)
		: err(pathAt(parent, key), `expected object, received ${describe(value)}`);
}

export function requireStringArray(input: Record<string, unknown>, key: string, parent: string): ParseResult<string[]> {
	const value = input[key];
	const path = pathAt(parent, key);
	if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
		return err(path, `expected string array, received ${describe(value)}`);
	}
	return ok([...value]);
}

export function collectIssues(target: ParseIssue[], ...results: readonly ParseResult<unknown>[]): void {
	for (const result of results) {
		if (!result.ok) {
			target.push(...result.issues);
		}
	}
}
