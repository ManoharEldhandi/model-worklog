# Model Worklog

Model Worklog is a local AI session logger. It records what a coding agent visibly does, including messages, plans, tool activity, commands, output, reviewed files, edits, errors, and provider-reported token usage. It stores redacted JSON evidence locally and presents it as a clear timeline in VS Code or the command line.

It does not record private chain-of-thought. When a provider exposes a readable reasoning summary, Model Worklog can retain that summary with its source and evidence grade.

## What You Install

- **VS Code extension:** Start, follow, stop, and review logged sessions. It bundles the Model Worklog supervisor and starts it after an explicit user action.
- **`model-worklog` npm package:** Standalone CLI and compatible local supervisor for terminals, scripts, CI, or custom integrations.
- **`model-worklog-sdk` npm package:** Adapter SDK for any AI framework that can report observable activity.

The VS Code extension and supervisor run where the workspace runs. In Remote-SSH, dev containers, and Codespaces, this means the remote extension host; workspace data is not silently sent to the desktop.

## VS Code

1. Install the Model Worklog VSIX.
2. Open a trusted workspace.
3. Run **Model Worklog: Enable Model Worklog**.
4. Open the **Model Worklog** Activity Bar view.
5. Select **Start Codex Session** and enter the task.

The extension starts or reconnects to one local loopback-only supervisor, registers the workspace, launches Codex through its documented App Server interface, and shows live readable evidence for that exact session. Select any retained session to review it later. **Stop Active Session** requests a clean Codex interruption.

Codex must be installed and authenticated on the same host as the workspace. If it is missing or fails, Model Worklog preserves a clear failed session rather than silently losing the run.

## CLI

Requires Node.js 22 or later.

```sh
npm install -g model-worklog
model-worklog supervisor start
model-worklog workspace trust .
model-worklog run -- npm test
model-worklog sessions list
model-worklog logs <session-id>
model-worklog watch <session-id> --format pretty
model-worklog cost <session-id>
model-worklog export <session-id> --output ./model-worklog-session.json
model-worklog verify ./model-worklog-session.json
```

The CLI package depends on the matching `model-worklog-supervisor` package, so no cloned repository or manually managed server script is required. The local store defaults to `~/.model-worklog`; set `MODEL_WORKLOG_HOME` to use another local directory.

## Integrate Any AI

Use `model-worklog-sdk` beside your AI provider or framework. The SDK reports structured, redacted events to the local supervisor and supports direct OpenAI/OpenAI-compatible, Anthropic, Gemini, and custom token usage mappings.

```ts
import { LocalSupervisorClient } from 'model-worklog-sdk';

const client = await LocalSupervisorClient.fromLocalEnvironment();
const session = await client.startSession({
  workspacePath: process.cwd(),
  actor: 'my-agent-adapter',
});

await session.message('I will inspect the failing test.');
await session.toolCalled({ tool: 'read_file', arguments: { path: 'src/app.ts' } });
await session.fileRead({ path: 'src/app.ts', tool: 'read_file' });
await session.fileChanged({ path: 'src/app.ts', operation: 'modified' });
await session.summary('The failing assertion uses an outdated expected value.');
await session.complete();
```

External SDK integrations are retained as `model-declared` evidence. Model Worklog never promotes them to direct observation. The Codex App Server relay is different: it directly receives the documented vendor stream, so those retained facts are `observed-native`. Missing or unsupported facts remain `unknown` with a reason.

See [Integration](docs/integration.md), [Evidence](docs/evidence-model.md), and [Adapter support](docs/adapter-capability-matrix.md).

## Privacy And Storage

- Evidence is redacted before it is written, returned, searched, or exported.
- The local supervisor binds only to loopback and requires a per-installation token for session data and changes.
- Absolute filesystem paths are scrubbed from exported evidence bundles.
- No workspace upload, telemetry, or hosted service is enabled by default.
- Evidence bundles are readable JSON with a canonical SHA-256 manifest for local integrity checks.