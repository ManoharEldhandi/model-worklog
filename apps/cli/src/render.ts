import type { HealthOutcome } from './protocolClient';
import { colorize, writeJson, writeJsonLine, writeLine } from './output';
import { SUPPORTED_API_MAJOR } from 'model-worklog-schema';
import type { CommandContext } from './context';

export function summarizeOutcome(outcome: HealthOutcome): unknown {
	switch (outcome.kind) {
		case 'ok':
		case 'incompatible':
			return { status: outcome.kind, url: outcome.url, health: outcome.health };
		case 'malformed':
			return { status: 'malformed', url: outcome.url, issues: outcome.issues };
		case 'http-error':
			return { status: 'http-error', url: outcome.url, statusCode: outcome.statusCode };
		case 'unreachable':
			return { status: 'unreachable', url: outcome.url, message: outcome.message };
	}
}

export function renderStatusPretty(context: CommandContext, outcome: HealthOutcome): void {
	const out = context.stdout;
	const enabled = context.color;

	switch (outcome.kind) {
		case 'ok': {
			writeLine(out, `${colorize('●', 'green', enabled)} supervisor ${outcome.health.supervisorVersion} — ${colorize('connected', 'green', enabled)}`);
			writeLine(out, `  url        ${outcome.url}`);
			writeLine(out, `  api        ${outcome.health.apiVersion} (schema ${outcome.health.schemaVersion})`);
			writeLine(out, `  instance   ${outcome.health.instanceId}`);
			writeLine(out, `  started    ${outcome.health.startedAt}`);
			writeLine(out, `  adapters   ${outcome.health.capabilities.adapters.length === 0 ? 'none' : outcome.health.capabilities.adapters.join(', ')}`);
			writeLine(out, `  features   ${outcome.health.capabilities.features.join(', ')}`);
			return;
		}
		case 'incompatible': {
			writeLine(out, `${colorize('●', 'yellow', enabled)} supervisor ${outcome.health.supervisorVersion} — ${colorize(`incompatible API ${outcome.health.apiVersion}`, 'yellow', enabled)}`);
			writeLine(context.stderr, `This client supports API major ${SUPPORTED_API_MAJOR}. Update the CLI or supervisor.`);
			return;
		}
		case 'http-error': {
			writeLine(out, `${colorize('●', 'red', enabled)} supervisor — ${colorize(`HTTP ${outcome.statusCode}`, 'red', enabled)}`);
			writeLine(context.stderr, `The supervisor answered ${outcome.url} with status ${outcome.statusCode}.`);
			return;
		}
		case 'malformed': {
			writeLine(out, `${colorize('●', 'red', enabled)} supervisor — ${colorize('malformed health response', 'red', enabled)}`);
			for (const issue of outcome.issues) {
				writeLine(context.stderr, `  ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`);
			}
			return;
		}
		case 'unreachable': {
			writeLine(out, `${colorize('●', 'red', enabled)} supervisor — ${colorize('not running', 'red', enabled)}`);
			writeLine(context.stderr, `  ${outcome.message}`);
			writeLine(context.stderr, `Start the supervisor (model-worklog-supervisor) and retry.`);
			return;
		}
	}
}

export function writeStatusJson(context: CommandContext, command: string, outcome: HealthOutcome): void {
	const output = { schemaVersion: 1, command, result: summarizeOutcome(outcome) };
	if (context.format === 'jsonl') {
		writeJsonLine(context.stdout, output);
	} else {
		writeJson(context.stdout, output);
	}
}
