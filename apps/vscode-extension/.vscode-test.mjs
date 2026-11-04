import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A checkout path can exceed macOS's Unix socket limit for the Code IPC handle.
const userData = mkdtempSync(join(tmpdir(), 'mwl-code-'));
process.once('exit', () => rmSync(userData, { recursive: true, force: true }));

export default defineConfig({
	files: 'out/test/**/*.test.js',
	launchArgs: ['--user-data-dir', userData],
	mocha: {
		ui: 'tdd',
	},
});
