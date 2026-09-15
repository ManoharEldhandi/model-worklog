import type { EnvRecord } from './constants';

export type OutputFormat = 'pretty' | 'json' | 'jsonl';
export type AnsiColor = 'bold' | 'green' | 'yellow' | 'red';

export interface OutputStream {
	readonly isTTY?: boolean;
	write(chunk: string): boolean;
}

const ANSI: Readonly<Record<AnsiColor, string>> = {
	bold: '\u001B[1m',
	green: '\u001B[32m',
	yellow: '\u001B[33m',
	red: '\u001B[31m',
};
const ANSI_RESET = '\u001B[0m';

export function resolveFormat(value: string | undefined, isTTY: boolean): OutputFormat | undefined {
	if (value === undefined) {
		return isTTY ? 'pretty' : 'json';
	}
	return value === 'pretty' || value === 'json' || value === 'jsonl' ? value : undefined;
}

export function resolveColor(isTTY: boolean, environment: EnvRecord): boolean {
	if (environment.NO_COLOR !== undefined) {
		return false;
	}
	if (environment.FORCE_COLOR !== undefined) {
		return environment.FORCE_COLOR !== '0';
	}
	return isTTY;
}

export function colorize(value: string, color: AnsiColor, enabled: boolean): string {
	return enabled ? `${ANSI[color]}${value}${ANSI_RESET}` : value;
}

export function writeLine(stream: OutputStream, value: string): void {
	stream.write(`${value}\n`);
}

export function writeJson(stream: OutputStream, value: unknown): void {
	writeLine(stream, JSON.stringify(value, null, 2));
}

export function writeJsonLine(stream: OutputStream, value: unknown): void {
	writeLine(stream, JSON.stringify(value));
}
