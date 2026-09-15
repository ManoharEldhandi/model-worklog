#!/usr/bin/env node
import { runCli } from './cli';

void runCli({
	argv: process.argv.slice(2),
	env: process.env,
	stdout: process.stdout,
	stderr: process.stderr,
})
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error: unknown) => {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`model-worklog: ${message}\n`);
		process.exitCode = 6;
	});
