import type { SessionEvent } from 'model-worklog-schema';

function text(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function values(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function command(payload: Record<string, unknown>): string | undefined {
	const executable = text(payload.executable) ?? text(payload.command);
	if (executable === undefined) {
		return undefined;
	}
	return [executable, ...values(payload.args)].join(' ');
}

function objectSummary(value: unknown): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'number') {
		return String(value);
	}
	if (typeof value === 'string') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map(objectSummary).join(', ');
	}
	if (typeof value === 'object') {
		return Object.entries(value as Record<string, unknown>).map(([key, entry]) => `${key}: ${objectSummary(entry)}`).join('; ');
	}
	return 'unavailable';
}

function summary(event: SessionEvent): string {
	const payload = event.payload as Record<string, unknown>;
	switch (event.kind) {
		case 'agent.message':
			return text(payload.text) ?? 'Assistant message';
		case 'agent.summary':
			return text(payload.summary) ?? (text(payload.message) ?? 'Assistant summary');
		case 'instruction.loaded':
			return `Loaded instruction ${text(payload.path) ?? 'source unavailable'}`;
		case 'tool.called':
			return `Using tool ${text(payload.tool) ?? 'unnamed tool'}${toolPath(payload) === undefined ? '' : ` on ${toolPath(payload)}`}`;
		case 'tool.completed':
			return `${text(payload.tool) ?? 'Tool'} ${payload.success === true ? 'completed' : 'did not complete'}`;
		case 'command.started':
		case 'process.started':
			return `Started ${command(payload) ?? 'command'}`;
		case 'command.completed':
		case 'process.completed':
			return `${command(payload) ?? 'Command'} ${payload.succeeded === true ? 'completed successfully' : `finished with exit ${String(payload.exitCode ?? 'unknown')}`}`;
		case 'process.output':
			return text(payload.text) ?? 'Process output unavailable';
		case 'file.read':
			return `Reviewed ${text(payload.path) ?? 'file'}`;
		case 'file.changed':
			return `${text(payload.operation) ?? 'Changed'} ${text(payload.path) ?? 'file'}`;
		case 'workspace.diff': {
			const current = payload.current as Record<string, unknown> | undefined;
			return payload.available === false ? 'Workspace diff could not be observed' : `Workspace diff: ${values(current?.paths).length} tracked path(s), ${payload.changedSinceStart === true ? 'changes detected' : 'no new changes'}`;
		}
		case 'usage.reported':
			return `${String(payload.totalTokens ?? 'unknown')} tokens reported by ${text(payload.provider) ?? 'provider'}`;
		case 'usage.unavailable':
			return text(payload.message) ?? 'Token usage unavailable';
		case 'adapter.lifecycle':
			return `${text(payload.adapter) ?? 'Adapter'}: ${text(payload.phase) ?? 'status update'}${text(payload.message) === undefined ? '' : ` - ${text(payload.message)}`}`;
		case 'session.started':
			return `${text(payload.runMode) ?? 'managed'} session started`;
		case 'session.completed':
			return 'Session completed';
		case 'session.interrupted':
			return 'Session interrupted';
		case 'session.failed':
			return `Session ${text(payload.state) ?? 'failed'}`;
		default:
			return objectSummary(payload);
	}
}

function toolPath(payload: Record<string, unknown>): string | undefined {
	const argumentsValue = payload.arguments;
	if (typeof argumentsValue !== 'object' || argumentsValue === null || Array.isArray(argumentsValue)) {
		return undefined;
	}
	const values = argumentsValue as Record<string, unknown>;
	return text(values.file_path) ?? text(values.path);
}

/** Formats stored JSON evidence for a human-readable VS Code output channel. */
export function formatSessionEvent(event: SessionEvent): readonly string[] {
	const lines = [
		`[${String(event.sequence).padStart(4, '0')}] ${event.occurredAt}  ${event.evidenceGrade}  ${event.kind}`,
		`  ${summary(event)}`,
	];
	if (event.unknownReason !== undefined) {
		lines.push(`  Evidence gap: ${event.unknownReason}`);
	}
	if (event.redaction.replacements > 0) {
		lines.push(`  Redaction: ${event.redaction.replacements} value(s) replaced`);
	}
	if (event.redaction.truncated) {
		lines.push('  Retention: output was truncated at the configured limit');
	}
	return lines;
}