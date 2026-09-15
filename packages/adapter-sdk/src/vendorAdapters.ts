import { basename, relative } from 'node:path';

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
	return containedPath !== '' && !containedPath.startsWith('..') ? containedPath : basename(path);
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
	) {}

	async ingestHook(input: unknown): Promise<AdapterIngestResult> {
		const event = asRecord(input);
		const hookEvent = optionalString(event?.hook_event_name);
		if (event === undefined || hookEvent === undefined) {
			await this.session.unknown('adapter.lifecycle', 'adapter-error', { adapter: 'claude-code', message: 'Hook input must contain hook_event_name.' });
			return { emitted: 1, completed: false };
		}
		const correlationId = eventCorrelation(event);
		const toolName = optionalString(event.tool_name);
		const toolInput = objectValue(event.tool_input);
		const sourceSessionId = optionalString(event.session_id);
		let emitted = 0;
		const record = async (kind: EventKind, payload: JsonObject, correlation = correlationId): Promise<void> => {
			await this.session.emitEvent(kind, payload, correlation);
			emitted += 1;
		};

		switch (hookEvent) {
			case 'SessionStart':
				await record('adapter.lifecycle', {
					adapter: 'claude-code', phase: 'session-started',
					...(sourceSessionId === undefined ? {} : { vendorSessionId: sourceSessionId }),
					...(optionalString(event.source) === undefined ? {} : { source: optionalString(event.source) as string }),
					...(optionalString(event.model) === undefined ? {} : { model: optionalString(event.model) as string }),
				});
				break;
			case 'UserPromptSubmit': {
				const prompt = optionalString(event.prompt);
				if (prompt === undefined) {
					await this.session.unknown('agent.message', 'not-observed', { adapter: 'claude-code', hookEvent, message: 'Hook payload did not include a prompt.' });
					emitted += 1;
				} else {
					await record('agent.message', { text: prompt });
				}
				break;
			}
			case 'InstructionsLoaded': {
				const path = displayPath(event.file_path, this.options.workspacePath);
				if (path === undefined) {
					await this.session.unknown('instruction.loaded', 'not-observed', { adapter: 'claude-code', hookEvent, message: 'Hook payload did not include file_path.' });
					emitted += 1;
				} else {
					await record('instruction.loaded', {
						adapter: 'claude-code', path,
						...(optionalString(event.memory_type) === undefined ? {} : { memoryType: optionalString(event.memory_type) as string }),
						...(optionalString(event.load_reason) === undefined ? {} : { loadReason: optionalString(event.load_reason) as string }),
						...(displayPath(event.trigger_file_path, this.options.workspacePath) === undefined ? {} : { triggerPath: displayPath(event.trigger_file_path, this.options.workspacePath) as string }),
					});
				}
				break;
			}
			case 'PreToolUse':
				if (toolName === undefined) {
					await this.session.unknown('tool.called', 'not-observed', { adapter: 'claude-code', hookEvent, message: 'Hook payload did not include tool_name.' });
					emitted += 1;
				} else {
					await record('tool.called', { tool: toolName, arguments: toolInput });
					const path = isReadTool(toolName) ? readPath(toolInput, this.options.workspacePath) : undefined;
					if (path !== undefined) {
						await record('file.read', { path, tool: toolName });
					}
				}
				break;
			case 'PostToolUse':
			case 'PostToolUseFailure':
				if (toolName === undefined) {
					await this.session.unknown('tool.completed', 'not-observed', { adapter: 'claude-code', hookEvent, message: 'Hook payload did not include tool_name.' });
					emitted += 1;
					break;
				}
				await record('tool.completed', {
					tool: toolName,
					success: hookEvent === 'PostToolUse',
					...(hookEvent === 'PostToolUse' ? { result: objectValue(event.tool_response) } : { error: optionalString(event.error) ?? 'Tool failed.' }),
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
					await this.session.unknown('file.changed', 'not-observed', { adapter: 'claude-code', hookEvent, message: 'Hook payload did not include file_path.' });
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
				await record('adapter.lifecycle', { adapter: 'claude-code', phase: 'turn-completed' });
				break;
			}
			case 'StopFailure':
				await record('adapter.lifecycle', {
					adapter: 'claude-code', phase: 'turn-failed',
					...(optionalString(event.error) === undefined ? {} : { error: optionalString(event.error) as string }),
				});
				break;
			case 'SessionEnd':
				await record('adapter.lifecycle', {
					adapter: 'claude-code', phase: 'session-ended',
					...(optionalString(event.reason) === undefined ? {} : { reason: optionalString(event.reason) as string }),
				});
				await this.session.complete('completed');
				return { emitted: emitted + 1, completed: true };
			default:
				await this.session.unknown('adapter.lifecycle', 'unsupported-capability', { adapter: 'claude-code', hookEvent, message: 'The hook event is not mapped by this adapter version.' });
				return { emitted: emitted + 1, completed: false };
		}
		return { emitted, completed: false };
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
					await record('file.read', { path, tool }, itemCorrelation);
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