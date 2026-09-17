import { stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';

import { isJsonValue, type EventKind, type JsonObject, type JsonValue, type UnknownReason } from 'model-worklog-schema';

import type { TokenUsageMapping, UsageProviderSelector } from './usage';

export interface AdapterEventSink {
	emitEvent(kind: EventKind, payload: JsonObject, correlationId?: string): Promise<unknown>;
	unknown(kind: EventKind, reason: UnknownReason, payload?: JsonObject): Promise<unknown>;
	reportProviderUsage(provider: UsageProviderSelector, response: unknown, mapping?: TokenUsageMapping): Promise<unknown>;
	complete(state?: 'completed' | 'failed' | 'interrupted'): Promise<unknown>;
}

export interface VendorAdapterOptions {
	readonly workspacePath?: string;
}

export interface AdapterIngestResult {
	readonly emitted: number;
	readonly completed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function objectValue(value: unknown): JsonObject {
	return asRecord(value) !== undefined && isJsonValue(value) ? value as JsonObject : {};
}

function eventCorrelation(value: Record<string, unknown>): string | undefined {
	return optionalString(value.tool_use_id) ?? optionalString(value.itemId) ?? optionalString(value.turn_id) ?? optionalString(value.turnId) ?? optionalString(value.prompt_id);
}

function displayPath(value: unknown, workspacePath: string | undefined): string | undefined {
	const path = optionalString(value);
	if (path === undefined) {
		return undefined;
	}
	if (workspacePath === undefined) {
		return path;
	}
	const containedPath = relative(workspacePath, path);
	return containedPath === '' ? '.' : !containedPath.startsWith('..') ? containedPath : basename(path);
}

function fileOperation(toolName: string, event?: string): 'created' | 'modified' | 'deleted' {
	if (event === 'add' || toolName === 'Write') {
		return 'created';
	}
	if (event === 'unlink' || toolName === 'Delete') {
		return 'deleted';
	}
	return 'modified';
}

function readPath(value: JsonObject, workspacePath: string | undefined): string | undefined {
	return displayPath(value.file_path ?? value.path, workspacePath);
}

async function readPathType(value: JsonObject, workspacePath: string | undefined): Promise<'file' | 'directory' | undefined> {
	const sourcePath = optionalString(value.file_path ?? value.path);
	if (sourcePath === undefined || workspacePath === undefined) {
		return undefined;
	}
	const absolutePath = isAbsolute(sourcePath) ? sourcePath : resolve(workspacePath, sourcePath);
	const relativePath = relative(workspacePath, absolutePath);
	if (relativePath !== '' && (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath))) {
		return undefined;
	}
	try {
		const metadata = await stat(absolutePath);
		return metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : undefined;
	} catch {
		return undefined;
	}
}

function isReadTool(tool: string): boolean {
	return ['read', 'read_file', 'view', 'imageview'].includes(tool.toLowerCase());
}

function completionState(value: unknown): 'completed' | 'failed' | 'interrupted' {
	return value === 'failed' ? 'failed' : value === 'interrupted' || value === 'cancelled' ? 'interrupted' : 'completed';
}

/**
 * Maps documented Claude Code hook payloads into one Model Worklog session.
 * Hook payloads remain model-declared because an external hook process is not
 * the supervisor trust boundary.
 */
export class ClaudeCodeAdapter {
	constructor(
		private readonly session: AdapterEventSink,
		private readonly options: VendorAdapterOptions = {},
		private readonly adapterName = 'claude-code',
	) {}

	protected completeWhenTurnStops(): boolean {
		return false;
	}

	protected completeWhenSessionEnds(): boolean {
		return true;
	}

	async ingestHook(input: unknown): Promise<AdapterIngestResult> {
		const event = asRecord(input);
		const hookEvent = optionalString(event?.hook_event_name);
		if (event === undefined || hookEvent === undefined) {
			await this.session.unknown('adapter.lifecycle', 'adapter-error', { adapter: this.adapterName, message: 'Hook input must contain hook_event_name.' });
			return { emitted: 1, completed: false };
		}
		const correlationId = eventCorrelation(event);
		const toolName = optionalString(event.tool_name);
		const toolInput = objectValue(event.tool_input);
		const toolResponse = event.tool_response ?? event.tool_result;
		const sourceSessionId = optionalString(event.session_id);
		let emitted = 0;
		const record = async (kind: EventKind, payload: JsonObject, correlation = correlationId): Promise<void> => {
			await this.session.emitEvent(kind, payload, correlation);
			emitted += 1;
		};

		switch (hookEvent) {
			case 'SessionStart':
				await record('adapter.lifecycle', {
					adapter: this.adapterName, phase: 'session-started',
					...(sourceSessionId === undefined ? {} : { vendorSessionId: sourceSessionId }),
					...(optionalString(event.source) === undefined ? {} : { source: optionalString(event.source) as string }),
					...(optionalString(event.model) === undefined ? {} : { model: optionalString(event.model) as string }),
				});
				break;
			case 'UserPromptSubmit': {
				const prompt = optionalString(event.prompt);
				if (prompt === undefined) {
					await this.session.unknown('agent.message', 'not-observed', { adapter: this.adapterName, hookEvent, message: 'Hook payload did not include a prompt.' });
					emitted += 1;
				} else {
					await record('agent.message', { role: 'user', text: prompt });
				}
				break;
			}
			case 'InstructionsLoaded': {
				const path = displayPath(event.file_path, this.options.workspacePath);
				if (path === undefined) {
					await this.session.unknown('instruction.loaded', 'not-observed', { adapter: this.adapterName, hookEvent, message: 'Hook payload did not include file_path.' });
					emitted += 1;
				} else {
					await record('instruction.loaded', {
						adapter: this.adapterName, path,
						...(optionalString(event.memory_type) === undefined ? {} : { memoryType: optionalString(event.memory_type) as string }),
						...(optionalString(event.load_reason) === undefined ? {} : { loadReason: optionalString(event.load_reason) as string }),
						...(displayPath(event.trigger_file_path, this.options.workspacePath) === undefined ? {} : { triggerPath: displayPath(event.trigger_file_path, this.options.workspacePath) as string }),
					});
				}
				break;
			}
			case 'PreToolUse':
				if (toolName === undefined) {
					await this.session.unknown('tool.called', 'not-observed', { adapter: this.adapterName, hookEvent, message: 'Hook payload did not include tool_name.' });
					emitted += 1;
				} else {
					await record('tool.called', { tool: toolName, arguments: toolInput });
					const path = isReadTool(toolName) ? readPath(toolInput, this.options.workspacePath) : undefined;
					if (path !== undefined) {
						const pathType = await readPathType(toolInput, this.options.workspacePath);
						await record('file.read', { path, tool: toolName, ...(pathType === undefined ? {} : { pathType }) });
					}
				}
				break;
			case 'PostToolUse':
			case 'PostToolUseFailure':
				if (toolName === undefined) {
					await this.session.unknown('tool.completed', 'not-observed', { adapter: this.adapterName, hookEvent, message: 'Hook payload did not include tool_name.' });
					emitted += 1;
					break;
				}
				await record('tool.completed', {
					tool: toolName,
					success: hookEvent === 'PostToolUse',
					...(hookEvent === 'PostToolUse' ? { result: objectValue(toolResponse) } : { error: optionalString(event.error) ?? 'Tool failed.' }),
				});
				if (['Write', 'Edit', 'Delete'].includes(toolName)) {
					const path = displayPath(toolInput.file_path, this.options.workspacePath);
					if (path !== undefined && hookEvent === 'PostToolUse') {
						await record('file.changed', { path, operation: fileOperation(toolName) });
					}
				}
				break;
			case 'FileChanged': {
				const path = displayPath(event.file_path, this.options.workspacePath);
				if (path === undefined) {
					await this.session.unknown('file.changed', 'not-observed', { adapter: this.adapterName, hookEvent, message: 'Hook payload did not include file_path.' });
					emitted += 1;
				} else {
					await record('file.changed', { path, operation: fileOperation('', optionalString(event.event)) });
				}
				break;
			}
			case 'Stop': {
				const summary = optionalString(event.last_assistant_message);
				if (summary !== undefined) {
					await record('agent.summary', { summary });
				}
				await record('adapter.lifecycle', { adapter: this.adapterName, phase: 'turn-completed' });
				if (this.completeWhenTurnStops()) {
					await this.session.complete('completed');
					return { emitted: emitted + 1, completed: true };
				}
				break;
			}
			case 'StopFailure':
				await record('adapter.lifecycle', {
					adapter: this.adapterName, phase: 'turn-failed',
					...(optionalString(event.error) === undefined ? {} : { error: optionalString(event.error) as string }),
				});
				break;
			case 'SessionEnd':
				await record('adapter.lifecycle', {
					adapter: this.adapterName, phase: 'session-ended',
					...(optionalString(event.reason) === undefined ? {} : { reason: optionalString(event.reason) as string }),
				});
				if (!this.completeWhenSessionEnds()) {
					break;
				}
				await this.session.complete('completed');
				return { emitted: emitted + 1, completed: true };
			case 'ErrorOccurred': {
				const error = asRecord(event.error);
				await record('adapter.lifecycle', {
					adapter: this.adapterName,
					phase: 'error-occurred',
					...(optionalString(error?.message) === undefined ? {} : { error: optionalString(error?.message) as string }),
					...(optionalString(event.error_context) === undefined ? {} : { context: optionalString(event.error_context) as string }),
				});
				return { emitted, completed: false };
			}
			case 'SubagentStop': {
				const summary = optionalString(event.last_assistant_message);
				if (summary !== undefined) {
					await record('agent.summary', { summary, source: 'subagent-response', adapter: this.adapterName });
					return { emitted, completed: false };
				}
				return { emitted, completed: false };
			}
			default:
				await this.session.unknown('adapter.lifecycle', 'unsupported-capability', { adapter: this.adapterName, hookEvent, message: 'The hook event is not mapped by this adapter version.' });
				return { emitted: emitted + 1, completed: false };
		}
		return { emitted, completed: false };
	}
}

/** Maps GitHub Copilot CLI PascalCase hook payloads into one session. */
export class CopilotCliHookAdapter extends ClaudeCodeAdapter {
	constructor(session: AdapterEventSink, options: VendorAdapterOptions = {}, adapterName = 'copilot-cli-hook') {
		super(session, options, adapterName);
	}

	protected override completeWhenTurnStops(): boolean {
		return true;
	}
}

/** Maps hooks for a Logger-launched interactive Copilot CLI session. Completion waits for its final local telemetry upload. */
export class CopilotCliInteractiveAdapter extends CopilotCliHookAdapter {
	constructor(session: AdapterEventSink, options: VendorAdapterOptions = {}) {
		super(session, options, 'copilot-cli-interactive');
	}

	protected override completeWhenTurnStops(): boolean {
		return false;
	}

	protected override completeWhenSessionEnds(): boolean {
		return false;
	}
}

/** Maps documented Codex App Server notifications into one Model Worklog session. */
export class CodexAppServerAdapter {
	private readonly suppressedRawReasoningItems = new Set<string>();

	constructor(
		private readonly session: AdapterEventSink,
		private readonly options: VendorAdapterOptions = {},
	) {}

	async ingestNotification(input: unknown): Promise<AdapterIngestResult> {
		const notification = asRecord(input);
		const method = optionalString(notification?.method);
		const params = asRecord(notification?.params);
		if (notification === undefined || method === undefined || params === undefined) {
			await this.session.unknown('adapter.lifecycle', 'adapter-error', { adapter: 'codex-app-server', message: 'A notification must contain method and object params.' });
			return { emitted: 1, completed: false };
		}
		const correlationId = eventCorrelation(params);
		let emitted = 0;
		const record = async (kind: EventKind, payload: JsonObject, correlation = correlationId): Promise<void> => {
			await this.session.emitEvent(kind, payload, correlation);
			emitted += 1;
		};

		if (method === 'item/agentMessage/delta') {
			const text = optionalString(params.delta);
			if (text === undefined) {
				await this.session.unknown('agent.message', 'not-observed', { adapter: 'codex-app-server', method, message: 'Message delta did not include text.' });
				return { emitted: 1, completed: false };
			}
			await record('agent.message', { text, source: 'assistant-commentary', delta: true }, optionalString(params.itemId) ?? correlationId);
			return { emitted, completed: false };
		}
		if (method === 'item/plan/delta' || method === 'item/reasoning/summaryTextDelta') {
			const summary = optionalString(params.delta);
			if (summary === undefined) {
				await this.session.unknown('agent.summary', 'not-observed', { adapter: 'codex-app-server', method, message: 'Visible summary delta did not include text.' });
				return { emitted: 1, completed: false };
			}
			await record('agent.summary', { summary, source: method === 'item/plan/delta' ? 'plan' : 'reasoning-summary', delta: true }, optionalString(params.itemId) ?? correlationId);
			return { emitted, completed: false };
		}
		if (method === 'item/reasoning/textDelta') {
			const itemId = optionalString(params.itemId) ?? 'unidentified';
			if (this.suppressedRawReasoningItems.has(itemId)) {
				return { emitted: 0, completed: false };
			}
			this.suppressedRawReasoningItems.add(itemId);
			await this.session.unknown('agent.summary', 'redacted', {
				adapter: 'codex-app-server', method,
				message: 'Raw model reasoning is not retained; visible reasoning summaries remain available when Codex provides them.',
			});
			return { emitted: 1, completed: false };
		}
		if (method === 'item/commandExecution/outputDelta') {
			const text = optionalString(params.delta);
			if (text === undefined) {
				await this.session.unknown('process.output', 'not-observed', { adapter: 'codex-app-server', method, message: 'Command output delta did not include text.' });
				return { emitted: 1, completed: false };
			}
			await record('process.output', { stream: optionalString(params.stream) ?? 'stdout', text, source: 'codex-command', delta: true }, optionalString(params.itemId) ?? correlationId);
			return { emitted, completed: false };
		}
		if (method === 'turn/plan/updated') {
			const plan = params.plan;
			await record('agent.summary', {
				source: 'plan',
				...(optionalString(params.explanation) === undefined ? {} : { summary: optionalString(params.explanation) as string }),
				...(isJsonValue(plan) ? { plan: plan as JsonValue } : {}),
			}, optionalString(params.turnId) ?? correlationId);
			return { emitted, completed: false };
		}
		if (method === 'thread/started' || method === 'turn/started' || method === 'thread/status/changed') {
			await record('adapter.lifecycle', { adapter: 'codex-app-server', phase: method, ...objectValue(params) });
			return { emitted, completed: false };
		}
		if (method === 'thread/tokenUsage/updated') {
			await this.session.reportProviderUsage('openai', { ...params, usage: params.usage });
			return { emitted: 1, completed: false };
		}
		if (method === 'thread/closed') {
			await record('adapter.lifecycle', { adapter: 'codex-app-server', phase: 'thread-closed', ...objectValue(params) });
			await this.session.complete('completed');
			return { emitted: emitted + 1, completed: true };
		}
		if (method === 'turn/completed') {
			const turn = asRecord(params.turn);
			await record('adapter.lifecycle', {
				adapter: 'codex-app-server', phase: 'turn-completed',
				...(optionalString(turn?.id) === undefined ? {} : { turnId: optionalString(turn?.id) as string }),
				state: completionState(turn?.status),
			});
			return { emitted, completed: false };
		}
		if (method === 'item/started' || method === 'item/completed') {
			const item = asRecord(params.item);
			const itemType = optionalString(item?.type);
			if (item === undefined || itemType === undefined) {
				await this.session.unknown('adapter.lifecycle', 'not-observed', { adapter: 'codex-app-server', method, message: 'Item notification did not include item.type.' });
				return { emitted: 1, completed: false };
			}
			const itemCorrelation = optionalString(item.id) ?? correlationId;
			if (itemType === 'commandExecution') {
				const command = optionalString(item.command);
				if (command === undefined) {
					await this.session.unknown(method === 'item/started' ? 'command.started' : 'command.completed', 'not-observed', { adapter: 'codex-app-server', itemType, message: 'Command item did not include command.' });
					return { emitted: 1, completed: false };
				}
				await record(method === 'item/started' ? 'command.started' : 'command.completed', {
					executable: command,
					...(method === 'item/completed' && typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
					...(method === 'item/completed' && typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
				}, itemCorrelation);
				return { emitted, completed: false };
			}
			if (itemType === 'fileChange' && method === 'item/completed') {
				const changes = Array.isArray(item.changes) ? item.changes : [];
				for (const change of changes) {
					const entry = asRecord(change);
					const path = displayPath(entry?.path, this.options.workspacePath);
					if (path !== undefined) {
						await record('file.changed', { path, operation: fileOperation('', optionalString(entry?.kind)) }, itemCorrelation);
					}
				}
				return { emitted, completed: false };
			}
			if (itemType === 'imageView' && method === 'item/completed') {
				const path = displayPath(item.path, this.options.workspacePath);
				if (path !== undefined) {
					await record('file.read', { path, tool: 'imageView' }, itemCorrelation);
					return { emitted, completed: false };
				}
			}
			if (itemType === 'agentMessage' && method === 'item/completed') {
				const text = optionalString(item.text);
				if (text !== undefined) {
					await record('agent.summary', { summary: text }, itemCorrelation);
					return { emitted, completed: false };
				}
			}
			if (['mcpToolCall', 'dynamicToolCall', 'collabToolCall', 'webSearch'].includes(itemType)) {
				const tool = optionalString(item.tool) ?? optionalString(itemType === 'webSearch' ? 'webSearch' : undefined) ?? itemType;
				const argumentsValue = objectValue(item.arguments);
				await record(method === 'item/started' ? 'tool.called' : 'tool.completed', {
					tool,
					...(method === 'item/started' ? { arguments: argumentsValue } : { success: item.status === 'completed' || item.success === true }),
				}, itemCorrelation);
				const path = method === 'item/started' && isReadTool(tool) ? readPath(argumentsValue, this.options.workspacePath) : undefined;
				if (path !== undefined) {
					const pathType = await readPathType(argumentsValue, this.options.workspacePath);
					await record('file.read', { path, tool, ...(pathType === undefined ? {} : { pathType }) }, itemCorrelation);
				}
				return { emitted, completed: false };
			}
			await record('adapter.lifecycle', { adapter: 'codex-app-server', phase: method, itemType }, itemCorrelation);
			return { emitted, completed: false };
		}
		await this.session.unknown('adapter.lifecycle', 'unsupported-capability', { adapter: 'codex-app-server', method, message: 'The notification is not mapped by this adapter version.' });
		return { emitted: 1, completed: false };
	}
}

interface CopilotToolState {
	readonly tool: string;
	readonly argumentsValue: JsonObject;
}

function toolResult(value: unknown): JsonValue | undefined {
	if (!isJsonValue(value)) {
		return undefined;
	}
	const serialized = JSON.stringify(value);
	return serialized.length <= 64 * 1024
		? value
		: { truncated: true, omittedCharacters: serialized.length - 64 * 1024, message: 'Tool result exceeded the retained size limit.' };
}

function copilotFileOperation(tool: string): 'created' | 'modified' | 'deleted' | undefined {
	const name = tool.toLowerCase();
	if (name.includes('delete') || name.includes('remove')) {
		return 'deleted';
	}
	if (name.includes('create') || name.includes('write') || name.includes('new_file')) {
		return 'created';
	}
	return name.includes('edit') || name.includes('patch') || name.includes('replace') ? 'modified' : undefined;
}

/**
 * Maps the documented Copilot CLI JSONL stream. It retains only visible messages
 * and tool activity; raw reasoning records are represented as unavailable.
 */
export class CopilotCliAdapter {
	private readonly tools = new Map<string, CopilotToolState>();
	private readonly suppressedReasoningTurns = new Set<string>();

	constructor(
		private readonly session: AdapterEventSink,
		private readonly options: VendorAdapterOptions = {},
	) {}

	async ingestEvent(input: unknown): Promise<AdapterIngestResult> {
		const event = asRecord(input);
		const type = optionalString(event?.type);
		const data = asRecord(event?.data);
		if (event === undefined || type === undefined) {
			await this.session.unknown('adapter.lifecycle', 'adapter-error', { adapter: 'copilot-cli', message: 'Copilot CLI event must contain a type.' });
			return { emitted: 1, completed: false };
		}
		const correlationId = eventCorrelation(data ?? {}) ?? optionalString(event.id);
		const record = (kind: EventKind, payload: JsonObject, correlation = correlationId): Promise<unknown> => this.session.emitEvent(kind, payload, correlation);

		switch (type) {
			case 'user.message': {
				const message = optionalString(data?.content);
				if (message === undefined) {
					await this.session.unknown('agent.message', 'not-observed', { adapter: 'copilot-cli', type, message: 'User message did not include visible content.' });
					return { emitted: 1, completed: false };
				}
				await record('agent.message', { role: 'user', text: message, source: 'copilot-cli' });
				return { emitted: 1, completed: false };
			}
			case 'assistant.message': {
				const message = optionalString(data?.content);
				if (message === undefined) {
					return { emitted: 0, completed: false };
				}
				await record('agent.message', { role: 'assistant', text: message, source: 'copilot-cli' });
				return { emitted: 1, completed: false };
			}
			case 'assistant.reasoning': {
				const turn = optionalString(data?.turnId) ?? correlationId ?? 'unidentified';
				if (this.suppressedReasoningTurns.has(turn)) {
					return { emitted: 0, completed: false };
				}
				this.suppressedReasoningTurns.add(turn);
				await this.session.unknown('agent.summary', 'redacted', {
					adapter: 'copilot-cli', type,
					message: 'Raw model reasoning is not retained. Copilot did not provide a separate visible reasoning summary for this turn.',
				});
				return { emitted: 1, completed: false };
			}
			case 'tool.execution_start': {
				const tool = optionalString(data?.toolName);
				const toolCallId = optionalString(data?.toolCallId) ?? correlationId;
				if (tool === undefined || toolCallId === undefined) {
					await this.session.unknown('tool.called', 'not-observed', { adapter: 'copilot-cli', type, message: 'Tool start did not include toolName and toolCallId.' });
					return { emitted: 1, completed: false };
				}
				const argumentsValue = objectValue(data?.arguments);
				this.tools.set(toolCallId, { tool, argumentsValue });
				await record('tool.called', { tool, arguments: argumentsValue }, toolCallId);
				const path = isReadTool(tool) ? readPath(argumentsValue, this.options.workspacePath) : undefined;
				if (path !== undefined) {
					const pathType = await readPathType(argumentsValue, this.options.workspacePath);
					await record('file.read', { path, tool, ...(pathType === undefined ? {} : { pathType }) }, toolCallId);
					return { emitted: 2, completed: false };
				}
				return { emitted: 1, completed: false };
			}
			case 'tool.execution_complete': {
				const toolCallId = optionalString(data?.toolCallId) ?? correlationId;
				const toolState = toolCallId === undefined ? undefined : this.tools.get(toolCallId);
				const tool = toolState?.tool ?? optionalString(data?.toolName);
				if (tool === undefined || toolCallId === undefined) {
					await this.session.unknown('tool.completed', 'not-observed', { adapter: 'copilot-cli', type, message: 'Tool completion could not be associated with a tool call.' });
					return { emitted: 1, completed: false };
				}
				this.tools.delete(toolCallId);
				await record('tool.completed', {
					tool,
					success: data?.success === true,
					...(data?.success === true && toolResult(data.result) !== undefined ? { result: toolResult(data.result) as JsonValue } : {}),
					...(data?.success === true ? {} : { error: optionalString(asRecord(data?.result)?.message) ?? 'Copilot tool execution failed.' }),
				}, toolCallId);
				const path = toolState === undefined ? undefined : readPath(toolState.argumentsValue, this.options.workspacePath);
				const operation = copilotFileOperation(tool);
				if (path !== undefined && operation !== undefined && data?.success === true) {
					await record('file.changed', { path, operation }, toolCallId);
					return { emitted: 2, completed: false };
				}
				return { emitted: 1, completed: false };
			}
			case 'assistant.turn_start':
			case 'assistant.turn_end':
			case 'model.call_start':
			case 'model.call_finished':
				await record('adapter.lifecycle', {
					adapter: 'copilot-cli', phase: type.replace(/[._]/g, '-'),
					...(optionalString(data?.model) === undefined ? {} : { model: optionalString(data?.model) as string }),
					...(optionalString(data?.outcome) === undefined ? {} : { outcome: optionalString(data?.outcome) as string }),
				});
				return { emitted: 1, completed: false };
			case 'result':
				await record('adapter.lifecycle', {
					adapter: 'copilot-cli', phase: 'result',
					...(typeof event.exitCode === 'number' ? { exitCode: event.exitCode } : {}),
				});
				return { emitted: 1, completed: false };
			default:
				return { emitted: 0, completed: false };
		}
	}
}