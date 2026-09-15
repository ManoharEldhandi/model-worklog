# Integration

Model Worklog accepts normalized events from any AI provider, tool framework, or agent runtime that can call the local SDK. The SDK connects only to a loopback supervisor using a user-local token.

## Standalone Setup

```sh
npm install -g model-worklog
model-worklog supervisor start
model-worklog workspace trust .
```

The VS Code extension performs the same startup and workspace registration after **Enable Model Worklog**. Use the CLI for scripts, CI, or custom integrations outside VS Code.

## Record A Session

```ts
import { LocalSupervisorClient } from 'model-worklog-sdk';

const client = await LocalSupervisorClient.fromLocalEnvironment();
const session = await client.startSession({
  workspacePath: process.cwd(),
  actor: 'my-ai-adapter',
});

await session.message('I will inspect the failing test.');
await session.summary('Located the failing assertion and selected a repair.');
await session.toolCalled({ tool: 'read_file', arguments: { path: 'src/app.ts' } });
await session.toolCompleted({ tool: 'read_file', success: true });
await session.fileRead({ path: 'src/app.ts', tool: 'read_file' });
await session.commandStarted({ executable: 'npm', args: ['test'] });
await session.commandCompleted({ executable: 'npm', args: ['test'], exitCode: 0 });
await session.fileChanged({ path: 'src/app.ts', operation: 'modified' });
await session.testCompleted({ name: 'npm test', success: true, durationMs: 842 });
await session.complete();
```

`summary()` is for a user-visible summary. Do not submit hidden reasoning or private chain-of-thought.

## Token Usage

Pass one completed provider response to `reportProviderUsage()`. The SDK records provider-reported counters or a documented deterministic composition; it does not estimate opaque billing totals.

```ts
const response = await openai.responses.create({ model: 'gpt-5.6-terra', input: 'Fix the test.' });
const report = await session.reportProviderUsage('openai', response);

if (!report.normalized.ok) {
  console.warn(`Usage unavailable: ${report.normalized.reason}`);
}
```

Built-in normalizers support OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages, and Gemini GenerateContent. A different provider can use explicit response-field mappings. For streaming APIs, submit the final cumulative response once.

## Codex

The VS Code **Start Codex Session** command launches `codex app-server` through the local supervisor for one task. The relay retains documented visible messages, plans, reasoning summaries, commands, command output, files, errors, instruction-source paths, usage updates, and terminal status. It supports user cancellation plus duration and reported-token limits.

Codex is the current direct-launch adapter. Other AI systems integrate through their documented hook, API, or framework callback surface and keep their appropriate evidence grade.