import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { fetchHealth } from '../protocolClient';
import { renderStatusPretty, writeStatusJson } from '../render';

export async function supervisorStatusCommand(context: CommandContext): Promise<ExitCode> {
	const outcome = await fetchHealth(context.supervisorUrl, { fetchImpl: context.fetchImpl });
	if (context.format === 'pretty') {
		renderStatusPretty(context, outcome);
	} else {
		writeStatusJson(context, 'supervisor.status', outcome);
	}
	if (outcome.kind === 'ok') {
		return ExitCode.Ok;
	}
	return outcome.kind === 'malformed' ? ExitCode.Internal : ExitCode.Unavailable;
}
