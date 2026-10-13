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

const names = new Set(entries.filter(({ value }) => value.private !== true).map(({ value }) => value.name));
for (const { path, value } of entries) {
	for (const [name, range] of Object.entries(value.dependencies ?? {})) {
		if (names.has(name) && typeof range === 'string' && !range.startsWith('file:') && range !== expected && range !== `^${expected}`) {
			throw new Error(`${path}: ${name} must reference ${expected}, received ${range}`);
		}
	}
}
const supervisorSource = await readFile(resolve('apps/local-supervisor/src/version.ts'), 'utf8');
if (/export const SUPERVISOR_VERSION = '([^']+)'/.exec(supervisorSource)?.[1] !== expected) {
	throw new Error('supervisor source version does not match the release manifests');
}
console.log(`Release versions, internal dependencies, and supervisor source verified: ${expected}`);
