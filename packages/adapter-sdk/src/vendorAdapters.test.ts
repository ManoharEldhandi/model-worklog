import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ClaudeCodeAdapter, CodexAppServerAdapter, CopilotCliAdapter, CopilotCliHookAdapter, CopilotCliInteractiveAdapter, type AdapterEventSink } from './vendorAdapters';

class RecordingSink implements AdapterEventSink {
	readonly calls: { readonly method: string; readonly payload: unknown; readonly correlationId?: string }[] = [];

	async emitEvent(kind: Parameters<AdapterEventSink['emitEvent']>[0], payload: Parameters<AdapterEventSink['emitEvent']>[1], correlationId?: string): Promise<void> {
		this.calls.push({ method: kind, payload, ...(correlationId === undefined ? {} : { correlationId }) });
	}

	async unknown(kind: Parameters<AdapterEventSink['unknown']>[0], reason: Parameters<AdapterEventSink['unknown']>[1], payload: Parameters<AdapterEventSink['unknown']>[2]): Promise<void> {
		this.calls.push({ method: `unknown:${kind}:${reason}`, payload });
	}

	async reportProviderUsage(provider: Parameters<AdapterEventSink['reportProviderUsage']>[0], response: unknown): Promise<void> {
		this.calls.push({ method: `usage:${provider}`, payload: response });
	}

	async complete(state?: 'completed' | 'failed' | 'interrupted'): Promise<void> {
		this.calls.push({ method: 'complete', payload: state ?? 'completed' });
	}
}

test('Claude Code hook adapter maps tool, file, instruction, and lifecycle evidence', async () => {
	const sink = new RecordingSink();
	const adapter = new ClaudeCodeAdapter(sink, { workspacePath: '/workspace' });

	await adapter.ingestHook({ hook_event_name: 'SessionStart', session_id: 'claude-session', source: 'startup', model: 'claude-sonnet' });
	await adapter.ingestHook({ hook_event_name: 'UserPromptSubmit', prompt_id: 'prompt-1', prompt: 'Fix the test.' });
	await adapter.ingestHook({ hook_event_name: 'InstructionsLoaded', file_path: '/workspace/CLAUDE.md', memory_type: 'Project', load_reason: 'session_start' });
	await adapter.ingestHook({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_use_id: 'tool-1', tool_input: { file_path: '/workspace/src/app.ts' } });
	await adapter.ingestHook({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'tool-1', tool_input: { file_path: '/workspace/src/app.ts' }, tool_response: { type: 'update' } });
	const result = await adapter.ingestHook({ hook_event_name: 'SessionEnd', reason: 'other' });

	assert.deepEqual(sink.calls, [
		{ method: 'adapter.lifecycle', payload: { adapter: 'claude-code', phase: 'session-started', vendorSessionId: 'claude-session', source: 'startup', model: 'claude-sonnet' } },
		{ method: 'agent.message', payload: { role: 'user', text: 'Fix the test.' }, correlationId: 'prompt-1' },
		{ method: 'instruction.loaded', payload: { adapter: 'claude-code', path: 'CLAUDE.md', memoryType: 'Project', loadReason: 'session_start' } },
		{ method: 'tool.called', payload: { tool: 'Edit', arguments: { file_path: '/workspace/src/app.ts' } }, correlationId: 'tool-1' },
		{ method: 'tool.completed', payload: { tool: 'Edit', success: true, result: { type: 'update' } }, correlationId: 'tool-1' },
		{ method: 'file.changed', payload: { path: 'src/app.ts', operation: 'modified' }, correlationId: 'tool-1' },
		{ method: 'adapter.lifecycle', payload: { adapter: 'claude-code', phase: 'session-ended', reason: 'other' } },
		{ method: 'complete', payload: 'completed' },
	]);
	assert.deepEqual(result, { emitted: 2, completed: true });
});

test('Claude Code hook adapter records gaps rather than guessing missing data', async () => {
	const sink = new RecordingSink();
	const adapter = new ClaudeCodeAdapter(sink);
	const result = await adapter.ingestHook({ hook_event_name: 'InstructionsLoaded' });

	assert.deepEqual(result, { emitted: 1, completed: false });
	assert.deepEqual(sink.calls, [{ method: 'unknown:instruction.loaded:not-observed', payload: { adapter: 'claude-code', hookEvent: 'InstructionsLoaded', message: 'Hook payload did not include file_path.' } }]);
});

test('Codex App Server adapter maps commands, files, summaries, usage, and session completion', async () => {
	const sink = new RecordingSink();
	const adapter = new CodexAppServerAdapter(sink, { workspacePath: '/workspace' });

	await adapter.ingestNotification({ method: 'item/started', params: { item: { id: 'item-command', type: 'commandExecution', command: 'npm test' } } });
	await adapter.ingestNotification({ method: 'item/completed', params: { item: { id: 'item-command', type: 'commandExecution', command: 'npm test', exitCode: 0, durationMs: 100 } } });
	await adapter.ingestNotification({ method: 'item/completed', params: { item: { id: 'item-file', type: 'fileChange', changes: [{ path: '/workspace/src/app.ts', kind: 'update' }] } } });
	await adapter.ingestNotification({ method: 'item/completed', params: { item: { id: 'item-message', type: 'agentMessage', text: 'Fixed the test.' } } });
	await adapter.ingestNotification({ method: 'thread/tokenUsage/updated', params: { model: 'gpt-5', usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } });
	const result = await adapter.ingestNotification({ method: 'thread/closed', params: { threadId: 'thr-1' } });

	assert.deepEqual(sink.calls, [
		{ method: 'command.started', payload: { executable: 'npm test' }, correlationId: 'item-command' },
		{ method: 'command.completed', payload: { executable: 'npm test', exitCode: 0, durationMs: 100 }, correlationId: 'item-command' },
		{ method: 'file.changed', payload: { path: 'src/app.ts', operation: 'modified' }, correlationId: 'item-file' },
		{ method: 'agent.summary', payload: { summary: 'Fixed the test.' }, correlationId: 'item-message' },
		{ method: 'usage:openai', payload: { model: 'gpt-5', usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 } } },
		{ method: 'adapter.lifecycle', payload: { adapter: 'codex-app-server', phase: 'thread-closed', threadId: 'thr-1' } },
		{ method: 'complete', payload: 'completed' },
	]);
	assert.deepEqual(result, { emitted: 2, completed: true });
});

test('Codex App Server adapter marks unmapped notifications as unsupported', async () => {
	const sink = new RecordingSink();
	const result = await new CodexAppServerAdapter(sink).ingestNotification({ method: 'future/event', params: {} });

	assert.deepEqual(result, { emitted: 1, completed: false });
	assert.deepEqual(sink.calls, [{ method: 'unknown:adapter.lifecycle:unsupported-capability', payload: { adapter: 'codex-app-server', method: 'future/event', message: 'The notification is not mapped by this adapter version.' } }]);
});

test('Codex App Server adapter retains visible summaries and command output but suppresses raw reasoning', async () => {
	const sink = new RecordingSink();
	const adapter = new CodexAppServerAdapter(sink, { workspacePath: '/workspace' });
	await adapter.ingestNotification({ method: 'item/agentMessage/delta', params: { itemId: 'msg-1', delta: 'I will inspect the failing test.' } });
	await adapter.ingestNotification({ method: 'item/reasoning/summaryTextDelta', params: { itemId: 'reasoning-1', delta: 'Checking the assertion and call path.' } });
	await adapter.ingestNotification({ method: 'item/reasoning/textDelta', params: { itemId: 'reasoning-1', delta: 'private model reasoning' } });
	await adapter.ingestNotification({ method: 'item/reasoning/textDelta', params: { itemId: 'reasoning-1', delta: 'more private model reasoning' } });
	await adapter.ingestNotification({ method: 'item/commandExecution/outputDelta', params: { itemId: 'cmd-1', stream: 'stderr', delta: 'test failure details' } });
	await adapter.ingestNotification({ method: 'item/completed', params: { item: { id: 'image-1', type: 'imageView', path: '/workspace/design.png' } } });
	assert.deepEqual(sink.calls, [
		{ method: 'agent.message', payload: { text: 'I will inspect the failing test.', source: 'assistant-commentary', delta: true }, correlationId: 'msg-1' },
		{ method: 'agent.summary', payload: { summary: 'Checking the assertion and call path.', source: 'reasoning-summary', delta: true }, correlationId: 'reasoning-1' },
		{ method: 'unknown:agent.summary:redacted', payload: { adapter: 'codex-app-server', method: 'item/reasoning/textDelta', message: 'Raw model reasoning is not retained; visible reasoning summaries remain available when Codex provides them.' } },
		{ method: 'process.output', payload: { stream: 'stderr', text: 'test failure details', source: 'codex-command', delta: true }, correlationId: 'cmd-1' },
		{ method: 'file.read', payload: { path: 'design.png', tool: 'imageView' }, correlationId: 'image-1' },
	]);
});

test('adapter read tools emit a separate file-read event with the workspace-relative path', async () => {
	const sink = new RecordingSink();
	const claude = new ClaudeCodeAdapter(sink, { workspacePath: '/workspace' });
	await claude.ingestHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: '/workspace/src/app.ts' }, tool_use_id: 'read_1' });
	const codex = new CodexAppServerAdapter(sink, { workspacePath: '/workspace' });
	await codex.ingestNotification({ method: 'item/started', params: { item: { id: 'read_2', type: 'dynamicToolCall', tool: 'read_file', arguments: { path: '/workspace/src/test.ts' } } } });
	assert.deepEqual(sink.calls.filter((call) => call.method === 'file.read'), [
		{ method: 'file.read', payload: { path: 'src/app.ts', tool: 'Read' }, correlationId: 'read_1' },
		{ method: 'file.read', payload: { path: 'src/test.ts', tool: 'read_file' }, correlationId: 'read_2' },
	]);
});

test('adapter read tools distinguish existing workspace directories from files', async () => {
	const workspacePath = await mkdtemp(join(tmpdir(), 'model-worklog-read-target-'));
	const directoryPath = join(workspacePath, 'docs');
	const filePath = join(workspacePath, 'README.md');
	try {
		await mkdir(directoryPath);
		await writeFile(filePath, '# Readme\n', 'utf8');
		const sink = new RecordingSink();
		const adapter = new CopilotCliHookAdapter(sink, { workspacePath });
		await adapter.ingestHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'directory', tool_input: { path: directoryPath } });
		await adapter.ingestHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'file', tool_input: { path: filePath } });
		assert.deepEqual(sink.calls.filter((call) => call.method === 'file.read'), [
			{ method: 'file.read', payload: { path: 'docs', tool: 'Read', pathType: 'directory' }, correlationId: 'directory' },
			{ method: 'file.read', payload: { path: 'README.md', tool: 'Read', pathType: 'file' }, correlationId: 'file' },
		]);
	} finally {
		await rm(workspacePath, { recursive: true, force: true });
	}
});

test('Copilot CLI adapter records visible messages and tools while suppressing raw reasoning', async () => {
	const sink = new RecordingSink();
	const adapter = new CopilotCliAdapter(sink, { workspacePath: '/workspace' });
	await adapter.ingestEvent({ type: 'user.message', data: { turnId: 'turn-1', content: 'Inspect the failing test.' } });
	await adapter.ingestEvent({ type: 'assistant.turn_start', data: { turnId: 'turn-1' } });
	await adapter.ingestEvent({ type: 'assistant.message', data: { turnId: 'turn-1', content: 'I will read the test first.' } });
	await adapter.ingestEvent({ type: 'assistant.reasoning', data: { turnId: 'turn-1', content: 'private reasoning' } });
	await adapter.ingestEvent({ type: 'assistant.reasoning', data: { turnId: 'turn-1', content: 'more private reasoning' } });
	await adapter.ingestEvent({ type: 'tool.execution_start', data: { turnId: 'turn-1', toolCallId: 'tool-1', toolName: 'edit_file', arguments: { path: '/workspace/src/app.ts' } } });
	await adapter.ingestEvent({ type: 'tool.execution_complete', data: { turnId: 'turn-1', toolCallId: 'tool-1', success: true, result: { changed: true } } });
	await adapter.ingestEvent({ type: 'assistant.message', data: { turnId: 'turn-1', content: 'The test is fixed.' } });
	await adapter.ingestEvent({ type: 'result', exitCode: 0 });

	assert.deepEqual(sink.calls, [
		{ method: 'agent.message', payload: { role: 'user', text: 'Inspect the failing test.', source: 'copilot-cli' }, correlationId: 'turn-1' },
		{ method: 'adapter.lifecycle', payload: { adapter: 'copilot-cli', phase: 'assistant-turn-start' }, correlationId: 'turn-1' },
		{ method: 'agent.message', payload: { role: 'assistant', text: 'I will read the test first.', source: 'copilot-cli' }, correlationId: 'turn-1' },
		{ method: 'unknown:agent.summary:redacted', payload: { adapter: 'copilot-cli', type: 'assistant.reasoning', message: 'Raw model reasoning is not retained. Copilot did not provide a separate visible reasoning summary for this turn.' } },
		{ method: 'tool.called', payload: { tool: 'edit_file', arguments: { path: '/workspace/src/app.ts' } }, correlationId: 'tool-1' },
		{ method: 'tool.completed', payload: { tool: 'edit_file', success: true, result: { changed: true } }, correlationId: 'tool-1' },
		{ method: 'file.changed', payload: { path: 'src/app.ts', operation: 'modified' }, correlationId: 'tool-1' },
		{ method: 'agent.message', payload: { role: 'assistant', text: 'The test is fixed.', source: 'copilot-cli' }, correlationId: 'turn-1' },
		{ method: 'adapter.lifecycle', payload: { adapter: 'copilot-cli', phase: 'result', exitCode: 0 } },
	]);
});

test('Copilot CLI hook adapter preserves documented post-tool results', async () => {
	const sink = new RecordingSink();
	const adapter = new CopilotCliHookAdapter(sink, { workspacePath: '/workspace' });
	await adapter.ingestHook({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'tool-1', tool_input: { file_path: '/workspace/src/app.ts' } });
	await adapter.ingestHook({ hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'tool-1', tool_input: { file_path: '/workspace/src/app.ts' }, tool_result: { result_type: 'success', text_result_for_llm: 'contents' } });
	assert.deepEqual(sink.calls, [
		{ method: 'tool.called', payload: { tool: 'Read', arguments: { file_path: '/workspace/src/app.ts' } }, correlationId: 'tool-1' },
		{ method: 'file.read', payload: { path: 'src/app.ts', tool: 'Read' }, correlationId: 'tool-1' },
		{ method: 'tool.completed', payload: { tool: 'Read', success: true, result: { result_type: 'success', text_result_for_llm: 'contents' } }, correlationId: 'tool-1' },
	]);
});

test('Copilot CLI hook adapter completes a finished agent turn', async () => {
	const sink = new RecordingSink();
	const adapter = new CopilotCliHookAdapter(sink);
	const result = await adapter.ingestHook({ hook_event_name: 'Stop', session_id: 'copilot-session', last_assistant_message: 'The focused test passed.' });
	assert.deepEqual(result, { emitted: 3, completed: true });
	assert.deepEqual(sink.calls, [
		{ method: 'agent.summary', payload: { summary: 'The focused test passed.' } },
		{ method: 'adapter.lifecycle', payload: { adapter: 'copilot-cli-hook', phase: 'turn-completed' } },
		{ method: 'complete', payload: 'completed' },
	]);
});

test('tracked interactive Copilot CLI adapter waits for final telemetry before completing', async () => {
	const sink = new RecordingSink();
	const adapter = new CopilotCliInteractiveAdapter(sink);
	const stop = await adapter.ingestHook({ hook_event_name: 'Stop', session_id: 'copilot-session', last_assistant_message: 'The focused test passed.' });
	const ended = await adapter.ingestHook({ hook_event_name: 'SessionEnd', session_id: 'copilot-session', reason: 'exit' });
	assert.deepEqual(stop, { emitted: 2, completed: false });
	assert.deepEqual(ended, { emitted: 1, completed: false });
	assert.deepEqual(sink.calls, [
		{ method: 'agent.summary', payload: { summary: 'The focused test passed.' } },
		{ method: 'adapter.lifecycle', payload: { adapter: 'copilot-cli-interactive', phase: 'turn-completed' } },
		{ method: 'adapter.lifecycle', payload: { adapter: 'copilot-cli-interactive', phase: 'session-ended', reason: 'exit' } },
	]);
});