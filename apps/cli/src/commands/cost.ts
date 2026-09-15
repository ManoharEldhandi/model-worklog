import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { writeJson, writeJsonLine, writeLine } from '../output';
import { requestSupervisor } from '../supervisorApi';

interface CostLineItem {
	readonly sequence: number;
	readonly provider?: string;
	readonly model?: string;
	readonly status: 'priced' | 'unknown';
	readonly totalNanoUsd?: string;
	readonly totalUsd?: string;
	readonly reason?: string;
}

interface CostReport {
	readonly schemaVersion: number;
	readonly tableVersion: string;
	readonly currency: string;
	readonly status: 'reported' | 'partial' | 'unknown';
	readonly totalNanoUsd: string;
	readonly totalUsd: string;
	readonly lineItems: readonly CostLineItem[];
}

interface CostResult {
	readonly sessionId: string;
	readonly cost: CostReport;
}

export async function costCommand(context: CommandContext, sessionId: string | undefined): Promise<ExitCode> {
	if (sessionId === undefined) {
		writeLine(context.stderr, 'Usage: model-worklog cost <session-id>');
		return ExitCode.InvalidInvocation;
	}
	const outcome = await requestSupervisor<CostResult>(context, `/v1/sessions/${encodeURIComponent(sessionId)}/cost`);
	if (outcome.kind === 'error') {
		writeLine(context.stderr, outcome.message);
		return ExitCode.Unavailable;
	}
	const report = outcome.data.cost;
	if (context.format === 'json') {
		writeJson(context.stdout, { schemaVersion: 1, command: 'cost', result: outcome.data });
		return ExitCode.Ok;
	}
	if (context.format === 'jsonl') {
		for (const lineItem of report.lineItems) {
			writeJsonLine(context.stdout, { schemaVersion: 1, tableVersion: report.tableVersion, currency: report.currency, ...lineItem });
		}
		return ExitCode.Ok;
	}
	writeLine(context.stdout, `Cost for ${outcome.data.sessionId}: $${report.totalUsd} ${report.currency} (${report.status}, ${report.tableVersion})`);
	for (const lineItem of report.lineItems) {
		const identity = `${lineItem.provider ?? 'provider unknown'}/${lineItem.model ?? 'model unknown'}`;
		writeLine(context.stdout, lineItem.status === 'priced'
			? `  #${lineItem.sequence} ${identity}: $${lineItem.totalUsd ?? '0'}`
			: `  #${lineItem.sequence} ${identity}: unknown (${lineItem.reason ?? 'unavailable'})`);
	}
	return ExitCode.Ok;
}