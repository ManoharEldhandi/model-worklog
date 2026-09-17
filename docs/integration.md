# Integration

Model Logger accepts normalized events from any AI provider, tool framework, or agent runtime that can call the local SDK. The SDK connects only to a loopback supervisor using a user-local token.

## Standalone Setup

```sh
npm install -g model-worklog
model-worklog supervisor start
model-worklog workspace trust .
```

The VS Code extension performs the same startup and workspace registration after **Enable Model Logger**, then obtains a renewable client lease for the trusted workspace. It installs a dedicated user-level Copilot CLI hook so that future normal Copilot CLI sessions report documented prompt, tool, result, error, and lifecycle events to the local supervisor. Restart a Copilot CLI process after enabling Logger because Copilot loads user hooks at CLI startup. Use **Start Interactive Copilot CLI** when an ordinary interactive Copilot session also needs final token totals: it opens the normal terminal UI with documented metadata-only OpenTelemetry export for that one session. If the extension launched the supervisor, it exits only after the final enabled VS Code client releases its lease and all live sessions have completed. A supervisor started by the CLI remains available after the extension disables. Enable does not create filesystem or terminal logs: activity appears only when a supported agent adapter supplies documented events. Use the CLI for scripts, CI, or custom integrations outside VS Code.

## SDK Setup

Install the SDK in the process that runs your AI system:

```sh
npm install model-worklog-sdk
```

The SDK does not start a supervisor or trust a workspace on behalf of your application. An operator must first start the local supervisor and trust the workspace that the application reports:

```sh
npm install -g model-worklog
model-worklog supervisor start
model-worklog workspace trust /absolute/path/to/workspace
```

At runtime, `LocalSupervisorClient.fromLocalEnvironment()` reads the supervisor URL from `MODEL_WORKLOG_SUPERVISOR_URL` and the credential from `MODEL_WORKLOG_TOKEN` or `MODEL_WORKLOG_HOME/auth-token`. The URL must be loopback HTTP. Set `MODEL_WORKLOG_HOME` consistently for the supervisor, CLI, and application when using a non-default local store.

## Rich Text And Canonical JSON

Model Logger preserves one redacted log stream, then offers two views of the
same activity. Give each integration a `title` when it starts a session; that
task name appears in log lists and becomes the default JSON download filename.

- **Text log:** VS Code **View Log**, `model-worklog logs <session-id> --format pretty`, and `model-worklog watch <session-id> --format pretty` describe visible requests, plans, reasoning summaries, tools, arguments, results, files, commands, tests, output, token counts, and lifecycle in readable language. In VS Code, View Log opens the selected log in one bottom Model Logger panel without moving editor focus; its sectioned content updates while the session runs, previews long entry bodies in two lines with an expand control, and places Tokens Used last.
- **Structured JSON:** `logs --format json` returns the session plus canonical events. `logs --format jsonl` and `watch --format jsonl` emit one canonical event per line for pipelines. `export <session-id> --output log.json` creates a portable evidence bundle with the session, all events, workspace snapshots, cost report, export-redaction metadata, and a SHA-256 manifest.

All JSON has already passed through supervisor redaction. The text view is a
human-oriented rendering; the canonical event payload remains available in the
JSON formats and export bundle.

## Show Logs In Your Application

The same session can drive any local presentation. Use `followEvents()` in the
Node process that runs the agent to receive every committed, redacted event from
the beginning of the session through completion. It polls the loopback
supervisor every 100 ms by default and accepts an `AbortSignal` when a viewer is
closed.

```ts
import { LocalSupervisorClient, formatSessionEventText } from 'model-worklog-sdk';

const client = await LocalSupervisorClient.fromLocalEnvironment();
const session = await client.startSession({
  workspacePath: process.cwd(),
  actor: 'my-agent',
});

// Terminal presentation
void session.followEvents((event) => {
  process.stdout.write(`${formatSessionEventText(event).join('\n')}\n`);
});

// Site or desktop application presentation. Keep this in the trusted backend;
// send `event` to an authenticated browser connection with your own WebSocket,
// Server-Sent Events, or framework transport.
void session.followEvents((event) => {
  applicationClients.broadcast({ type: 'model-worklog-event', event });
}, { afterSequence: 0, signal: viewerAbortController.signal });
```

Do not connect browser code directly to the supervisor and do not expose
`MODEL_WORKLOG_TOKEN` to a browser. The supervisor is loopback-only by design;
your application backend decides which authenticated viewers may receive its
already-redacted events.

## Record A Session

```ts
import { readFile } from 'node:fs/promises';
import { LocalSupervisorClient } from 'model-worklog-sdk';

const client = await LocalSupervisorClient.fromLocalEnvironment();
const session = await client.startSession({
  workspacePath: process.cwd(),
  actor: 'my-ai-adapter',
  title: 'Fix the failing parser test',
});

await session.userMessage('Fix the failing parser test.');
await session.plan('Read the parser and test, then make the smallest repair.', [
  'Read src/parser.ts',
  'Read src/parser.test.ts',
  'Run the focused test',
]);
await session.reasoningSummary('The expected value appears outdated.');

const contents = await session.runTool(
  { tool: 'read_file', arguments: { path: 'src/parser.ts' }, correlationId: 'tool_read_1' },
  () => readFile('src/parser.ts', 'utf8'),
);
await session.fileRead({ path: 'src/app.ts', tool: 'read_file' });
await session.commandStarted({ executable: 'npm', args: ['test'] });
await session.commandCompleted({ executable: 'npm', args: ['test'], exitCode: 0 });
await session.fileChanged({ path: 'src/app.ts', operation: 'modified' });
await session.testCompleted({ name: 'npm test', success: true, durationMs: 842 });
await session.summary(`Reviewed ${contents.length} characters and completed the repair.`);
await session.complete();
```

Use `userMessage()` and `agentMessage()` for visible conversation, `plan()` for
a high-level plan, and `reasoningSummary()` only for a provider-visible summary.
`runTool()` records a correlated `tool.called`/`tool.completed` pair and captures
a JSON-compatible result or an error. Record file reads and changes when your
application actually performs them. Do not submit hidden reasoning or private
chain-of-thought.

## Token Usage

Pass one completed provider response to `reportProviderUsage()`. The SDK records provider-reported counters or a documented deterministic composition; it does not estimate opaque billing totals.

```ts
const response = await openai.responses.create({ model: 'gpt-5.6-terra', input: 'Fix the test.' });
const report = await session.reportProviderUsage('openai', response);

if (!report.normalized.ok) {
  console.warn(`Token count was not reported: ${report.normalized.reason}`);
}
```

Built-in normalizers support OpenAI Responses, OpenAI-compatible Chat Completions, Anthropic Messages, and Gemini GenerateContent. A different provider can use explicit response-field mappings. For streaming APIs, submit the final cumulative response once.

If a provider response has no usage counters, Logger does not invent a token total or add a warning update to the log. The completed log simply shows that a token count was not reported.

## Provider And Agent Integration

Model Logger can be integrated with any agent runtime that can call the Node SDK
from its backend or the local HTTP API. It cannot passively discover activity inside arbitrary
processes: the runtime needs to call the SDK where it receives visible messages,
plans, tool callbacks, file operations, command results, and provider responses.

| Agent or provider | Integration path | What is retained |
| --- | --- | --- |
| Codex App Server | Use VS Code **Log a Codex Task** or `POST /v1/codex-sessions`. | Direct documented events as `observed-native`, plus process lifecycle as `observed-boundary`. |
| GitHub Copilot CLI task | Use VS Code **Log a Copilot CLI Task** or `POST /v1/copilot-sessions`. | Documented JSON message/tool events and OpenTelemetry usage spans as `observed-native`, plus process lifecycle as `observed-boundary`. |
| GitHub Copilot CLI interactive | Use VS Code **Start Interactive Copilot CLI**. | Hook-supplied visible activity as `model-declared`, plus final documented metadata-only OpenTelemetry usage spans as `observed-native`. |
| GitHub Copilot CLI personal hook | Enable Model Logger, then start a new normal Copilot CLI session in the trusted workspace. | Hook-supplied user prompts, tool activity/results, errors, and lifecycle as `model-declared`. Token counters are unavailable unless the tracked interactive or direct task launcher is used. |
| Claude Code | Bridge documented hook payloads with `ClaudeCodeAdapter` and a `WorklogSession`. | Hook-reported lifecycle, instruction, tool, file, and visible summary events as `model-declared`. |
| GitHub Copilot | Call the generic SDK from a Copilot-based agent, extension integration, or tool wrapper where documented visible events are available. | Integration-supplied events are `model-declared`. VS Code Copilot Chat messages and tools are not passively captured. |
| OpenAI or OpenAI-compatible | Use the generic SDK around tool execution and pass the final response to `reportProviderUsage('openai', response)`. | Visible activity and provider token usage as `model-declared`. |
| Gemini | Use the generic SDK around tool execution and pass the final response to `reportProviderUsage('gemini', response)`. | Visible activity and provider token usage as `model-declared`. |
| Other agents and frameworks | Call the same SDK methods from the agent loop or framework callbacks. Use `TokenUsageMapping` for an unrecognized usage response. | Only events the integration actually reports, marked `model-declared`; unsupported visibility is `unknown`. |

## Agent Visibility

Model Logger does not attempt passive capture of VS Code Copilot Chat, arbitrary model CLIs, filesystem changes, or terminal buffers. Those sources cannot prove which agent initiated an action and do not safely expose the model's visible tool stream.

To capture real agent activity, use a documented adapter, hook, or SDK integration at the point where the agent emits visible messages, plans, tool calls, files, commands, results, and provider usage. Codex App Server and GitHub Copilot CLI are direct adapters. The Copilot relay launches `copilot --prompt` with its documented JSON event stream and metadata-only OpenTelemetry file export; it never enables prompt/response content capture in telemetry. Enable also installs one dedicated Copilot CLI user hook, which gives normal future `copilot` sessions structured prompt and tool lifecycle logs while Logger is enabled. Claude Code hooks and other SDK integrations are recorded as `model-declared`. VS Code Copilot Chat has no passive event capture path; it needs a documented GitHub event surface or an explicit SDK/tool-wrapper integration. Model Logger never retains raw private chain-of-thought; it keeps only a provider-visible reasoning summary where an adapter exposes one.

## Codex

The VS Code **Log a Codex Task** command launches `codex app-server` through the local supervisor for one task. The relay retains documented visible messages, plans, reasoning summaries, commands, command output, files, errors, instruction-source paths, usage updates, and terminal status. It supports user cancellation plus duration and reported-token limits.

Codex is the current direct-launch adapter. Other AI systems integrate through their documented hook, API, or framework callback surface and keep their appropriate `model-declared` or `unknown` evidence grade.
