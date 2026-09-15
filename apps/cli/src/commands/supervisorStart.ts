import { launchDetachedSupervisor } from 'model-worklog-supervisor';
import { setTimeout as delay } from 'node:timers/promises';

import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { writeLine } from '../output';
import { assertLoopbackUrl, fetchHealth, type HealthOutcome } from '../protocolClient';

const STARTUP_TIMEOUT_MS = 8_000;

export interface SupervisorStartDependencies {
	readonly launch?: typeof launchDetachedSupervisor;
	readonly fetchHealth?: (url: string) => Promise<HealthOutcome>;
	readonly delay?: (milliseconds: number) => Promise<void>;
	readonly now?: () => number;
}

export async function supervisorStartCommand(context: CommandContext, dependencies: SupervisorStartDependencies = {}): Promise<ExitCode> {
	const checkHealth = dependencies.fetchHealth ?? ((url: string) => fetchHealth(url, { fetchImpl: context.fetchImpl }));
	const wait = dependencies.delay ?? ((milliseconds: number) => delay(milliseconds));
	const now = dependencies.now ?? Date.now;
	let target: URL;
	try {
		target = assertLoopbackUrl(context.supervisorUrl);
	} catch (error) {
		writeLine(context.stderr, error instanceof Error ? error.message : String(error));
		return ExitCode.InvalidInvocation;
	}
	const initial = await checkHealth(context.supervisorUrl);
	if (initial.kind === 'ok') {
		writeLine(context.stdout, `Local supervisor is already running at ${target.origin}.`);
		return ExitCode.Ok;
	}
	if (initial.kind !== 'unreachable') {
		writeLine(context.stderr, `Cannot start a supervisor while ${target.origin} returns ${initial.kind}.`);
		return ExitCode.Unavailable;
	}
	try {
		(dependencies.launch ?? launchDetachedSupervisor)({
			host: target.hostname === 'localhost' ? '127.0.0.1' : target.hostname.replace(/^\[(.+)\]$/, '$1'),
			port: target.port === '' ? 80 : Number(target.port),
		});
	} catch (error) {
		writeLine(context.stderr, `Could not launch the local supervisor: ${error instanceof Error ? error.message : String(error)}`);
		return ExitCode.Internal;
	}
	const deadline = now() + STARTUP_TIMEOUT_MS;
	for (;;) {
		const health = await checkHealth(context.supervisorUrl);
		if (health.kind === 'ok') {
			writeLine(context.stdout, `Local supervisor started at ${target.origin}.`);
			return ExitCode.Ok;
		}
		if (now() >= deadline) {
			writeLine(context.stderr, `The local supervisor did not become healthy before the startup timeout (${health.kind}).`);
			return ExitCode.Unavailable;
		}
		await wait(100);
	}
}