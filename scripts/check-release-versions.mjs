import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const manifests = [
	'package.json',
	'packages/event-schema/package.json',
	'packages/adapter-sdk/package.json',
	'apps/local-supervisor/package.json',
	'apps/cli/package.json',
	'apps/vscode-extension/package.json',
];

const entries = await Promise.all(manifests.map(async (path) => {
	const content = await readFile(resolve(path), 'utf8');
	return { path, value: JSON.parse(content) };
}));
const expected = entries[0]?.value.version;
const mismatches = entries.filter(({ value }) => value.version !== expected);

if (typeof expected !== 'string' || expected.trim() === '' || mismatches.length > 0) {
	for (const { path, value } of entries) {
		console.error(`${path}: ${String(value.version)}`);
	}
	throw new Error('all release manifests must use one non-empty version');
}

console.log(`Release versions verified: ${expected}`);
