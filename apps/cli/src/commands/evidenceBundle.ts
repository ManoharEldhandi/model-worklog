import { chmod, readFile, writeFile } from 'node:fs/promises';

import { ExitCode } from '../constants';
import type { CommandContext } from '../context';
import { writeJson, writeJsonLine, writeLine } from '../output';
import { requestSupervisor } from '../supervisorApi';

interface ExportResult {
	readonly schemaVersion: number;
	readonly bundle: Record<string, unknown>;
}

interface Verification {
	readonly schemaVersion: number;
	readonly valid: boolean;
	readonly reason?: string;
}

interface VerifyResult {
	readonly schemaVersion: number;
	readonly verification: Verification;
}

function emit(context: CommandContext, command: 'export' | 'verify', result: Record<string, unknown>): void {
	if (context.format === 'pretty') {
		if (command === 'export') {
			writeLine(context.stdout, `Exported evidence bundle for ${result.sessionId as string} to ${result.outputPath as string}.`);
		} else {
			writeLine(context.stdout, (result.valid as boolean) ? 'Evidence bundle integrity: valid.' : `Evidence bundle integrity: invalid (${result.reason as string}).`);
		}
		return;
	}
	const output = { schemaVersion: 1, command, result };
	if (context.format === 'jsonl') {
		writeJsonLine(context.stdout, output);
	} else {
		writeJson(context.stdout, output);
	}
}

export async function exportEvidenceBundleCommand(context: CommandContext, sessionId: string | undefined, outputPath: string | undefined): Promise<ExitCode> {
	if (sessionId === undefined || outputPath === undefined) {
		writeLine(context.stderr, 'Usage: model-worklog export <session-id> --output <file>');
		return ExitCode.InvalidInvocation;
	}
	const outcome = await requestSupervisor<ExportResult>(context, `/v1/sessions/${encodeURIComponent(sessionId)}/evidence-bundle`);
	if (outcome.kind === 'error') {
		writeLine(context.stderr, outcome.message);
		return ExitCode.Unavailable;
	}
	try {
		await writeFile(outputPath, `${JSON.stringify(outcome.data.bundle, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
		if (process.platform !== 'win32') {
			await chmod(outputPath, 0o600);
		}
	} catch (error) {
		writeLine(context.stderr, `Could not write evidence bundle: ${error instanceof Error ? error.message : String(error)}`);
		return ExitCode.Internal;
	}
	emit(context, 'export', { sessionId, outputPath });
	return ExitCode.Ok;
}

export async function verifyEvidenceBundleCommand(context: CommandContext, inputPath: string | undefined): Promise<ExitCode> {
	if (inputPath === undefined) {
		writeLine(context.stderr, 'Usage: model-worklog verify <file>');
		return ExitCode.InvalidInvocation;
	}
	let bundle: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(await readFile(inputPath, 'utf8'));
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
			throw new Error('file must contain a JSON object');
		}
		bundle = parsed as Record<string, unknown>;
	} catch (error) {
		writeLine(context.stderr, `Could not read evidence bundle: ${error instanceof Error ? error.message : String(error)}`);
		return ExitCode.InvalidInvocation;
	}
	const outcome = await requestSupervisor<VerifyResult>(context, '/v1/evidence-bundles/verify', 'POST', { bundle });
	if (outcome.kind === 'error') {
		writeLine(context.stderr, outcome.message);
		return ExitCode.Unavailable;
	}
	const verification = outcome.data.verification;
	emit(context, 'verify', { inputPath, valid: verification.valid, ...(verification.reason === undefined ? {} : { reason: verification.reason }) });
	return verification.valid ? ExitCode.Ok : ExitCode.Internal;
}