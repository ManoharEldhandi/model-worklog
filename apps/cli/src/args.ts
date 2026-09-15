export type ParsedOptionValue = string | true;

export interface ParsedArgs {
	readonly positionals: readonly string[];
	readonly options: ReadonlyMap<string, ParsedOptionValue>;
}

/**
 * Small, dependency-free parser for the CLI surface.  `--` always preserves
 * the remaining values verbatim so managed commands may use their own flags.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	const positionals: string[] = [];
	const options = new Map<string, ParsedOptionValue>();
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === undefined) {
			continue;
		}
		if (value === '--') {
			positionals.push(...argv.slice(index + 1));
			break;
		}
		if (value.startsWith('--') && value.length > 2) {
			const equals = value.indexOf('=');
			if (equals > 2) {
				options.set(value.slice(2, equals), value.slice(equals + 1));
				continue;
			}
			const next = argv[index + 1];
			if (next !== undefined && next !== '--' && !next.startsWith('-')) {
				options.set(value.slice(2), next);
				index += 1;
			} else {
				options.set(value.slice(2), true);
			}
			continue;
		}
		if (value.startsWith('-') && value.length === 2) {
			options.set(value.slice(1), true);
			continue;
		}
		positionals.push(value);
	}
	return { positionals, options };
}

export function optionFlag(options: ReadonlyMap<string, ParsedOptionValue>, ...names: readonly string[]): boolean {
	return names.some((name) => options.get(name) === true);
}

export function optionString(options: ReadonlyMap<string, ParsedOptionValue>, name: string): string | undefined {
	const value = options.get(name);
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
