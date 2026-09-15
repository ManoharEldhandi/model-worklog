import { SCHEMA_VERSION, SUPPORTED_API_MAJOR } from 'model-worklog-schema';

import { CLI_VERSION, ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { colorize, writeJson, writeJsonLine, writeLine } from '../output';
import { fetchHealth, type HealthOutcome } from '../protocolClient';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
	readonly name: string;
	readonly status: CheckStatus;
	readonly detail: string;
}

export interface DoctorOptions {
	readonly requireSupervisor?: boolean;
}

const MINIMUM_NODE_MAJOR = 22;

function nodeMajor(version: string): number {
	const match = /^v?(\d+)\./.exec(version);
	if (match === null || match[1] === undefined) {
		return 0;
	}
	return Number.parseInt(match[1], 10);
}

function supervisorCheck(outcome: HealthOutcome): DoctorCheck {
	switch (outcome.kind) {
		case 'ok':
			return { name: 'supervisor', status: 'ok', detail: `connected to ${outcome.url} (${outcome.health.supervisorVersion})` };
		case 'incompatible':
			return { name: 'supervisor', status: 'warn', detail: `incompatible API ${outcome.health.apiVersion}; client supports major ${SUPPORTED_API_MAJOR}` };
		case 'http-error':
			return { name: 'supervisor', status: 'warn', detail: `HTTP ${outcome.statusCode} from ${outcome.url}` };
		case 'malformed':
			return { name: 'supervisor', status: 'warn', detail: `malformed health response from ${outcome.url}` };
		case 'unreachable':
			return { name: 'supervisor', status: 'warn', detail: `not running (${outcome.message})` };
	}
}

function statusColor(status: CheckStatus): 'green' | 'yellow' | 'red' {
	if (status === 'ok') {
		return 'green';
	}
	return status === 'warn' ? 'yellow' : 'red';
}

function symbol(status: CheckStatus): string {
	if (status === 'ok') {
		return '✔';
	}
	return status === 'warn' ? '!' : '✘';
}

export async function doctorCommand(context: CommandContext, options: DoctorOptions = {}): Promise<ExitCode> {
	const checks: DoctorCheck[] = [];

	const currentNodeMajor = nodeMajor(process.versions.node);
	checks.push({
		name: 'node',
		status: currentNodeMajor >= MINIMUM_NODE_MAJOR ? 'ok' : 'warn',
		detail: `Node.js ${process.versions.node}${currentNodeMajor >= MINIMUM_NODE_MAJOR ? '' : ` (recommended >= ${MINIMUM_NODE_MAJOR})`}`,
	});
	checks.push({ name: 'cli', status: 'ok', detail: `model-worklog ${CLI_VERSION}` });
	checks.push({ name: 'protocol', status: 'ok', detail: `API major ${SUPPORTED_API_MAJOR}, schema version ${SCHEMA_VERSION}` });

	const outcome = await fetchHealth(context.supervisorUrl, { fetchImpl: context.fetchImpl });
	checks.push(supervisorCheck(outcome));

	const requireSupervisor = options.requireSupervisor === true;
	const envFail = checks.some((check) => check.name !== 'supervisor' && check.status === 'fail');
	const supervisorOk = outcome.kind === 'ok';
	const ok = !envFail && (!requireSupervisor || supervisorOk);

	if (context.format === 'json') {
		writeJson(context.stdout, { schemaVersion: 1, command: 'doctor', ok, checks });
	} else if (context.format === 'jsonl') {
		writeJsonLine(context.stdout, { schemaVersion: 1, command: 'doctor', ok, checks });
	} else {
		writeLine(context.stdout, colorize('model-worklog doctor', 'bold', context.color));
		for (const check of checks) {
			const mark = colorize(symbol(check.status), statusColor(check.status), context.color);
			writeLine(context.stdout, `  ${mark} ${check.name.padEnd(11)} ${check.detail}`);
		}
	}

	if (envFail) {
		return ExitCode.Internal;
	}
	if (requireSupervisor && !supervisorOk) {
		return ExitCode.Unavailable;
	}
	return ExitCode.Ok;
}
