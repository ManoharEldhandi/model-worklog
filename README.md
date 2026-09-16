# Model Logger

Model Logger is a local AI activity logger. It records what a coding agent visibly does: messages, high-level plans, readable reasoning summaries, tools and results, commands, output, reviewed files, edits, errors, tests, and provider-reported token usage. It stores redacted JSON locally and presents the same activity in the VS Code sidebar or the command line.

It does not record private chain-of-thought. When a provider exposes a readable reasoning summary, Model Logger can retain that summary and a plain label showing where the update came from.

Use text logs for review and JSON for automation or download: `model-worklog logs <session-id> --format pretty` shows the readable activity, `--format json` returns the session and events, and `model-worklog export <session-id> --output log.json` writes the full redacted JSON download with an integrity manifest.

## What You Install

- **Model Logger for VS Code:** Start, view, download, and disable activity logging in the sidebar. It bundles the local supervisor and starts it after an explicit user action.
- **`model-worklog` npm package:** Standalone CLI and compatible local supervisor for terminals, scripts, CI, or custom integrations.
- **`model-worklog-sdk` npm package:** Adapter SDK for any AI framework that can report observable activity.

The VS Code extension and supervisor run where the workspace runs. In Remote-SSH, dev containers, and Codespaces, this means the remote extension host; workspace data is not silently sent to the desktop.

## VS Code

1. Download the VSIX from the GitHub release or build it locally with `npm run extension:package`.
2. Install it with VS Code's **Extensions: Install from VSIX...** command, or run `code --install-extension model-worklog-<version>.vsix`.
3. Open a trusted workspace.
4. Run **Model Logger: Enable Model Logger**.
5. Open the **Model Logger** Activity Bar view.
6. Select **Log a Codex Task** and enter the task.

The extension starts or reconnects to one local loopback-only supervisor, registers the workspace, and launches Codex through its documented App Server interface. Each log is named after its task: a Codex prompt, a logged command, an SDK `title`, or the first user request. The sidebar lists **Live Activity** and **Previous Activity**. Select **View Log** to show one readable selected log in the **Model Logger** panel at the bottom of VS Code. It updates about every 150 ms after the supervisor saves new activity and keeps the editor focused. It shows only sections that have content, such as User Request, Agent Plan, Tools Used, Agent Response, and Tokens Used. **Download JSON** uses the task name as its default filename, while **Delete Log** permanently removes a finished log after confirmation. **Disable Logger** disconnects this VS Code window and hides activity without interrupting your agent or other work.

Codex must be installed and authenticated on the same host as the workspace. If it is missing or fails, Model Logger preserves a clear failed session rather than silently losing the run.

After the extension is published to the VS Code Marketplace, install it by its extension identifier: `manohareldhandi.model-worklog`.

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

Use `model-worklog-sdk` beside your AI provider or framework. The SDK reports structured events to the local supervisor and supports OpenAI/OpenAI-compatible, Anthropic, Gemini, and custom token usage mappings.

Install the SDK in the application that runs your agent:

```sh
npm install model-worklog-sdk
```

Before the application starts a session, a local supervisor must be running and the application workspace must be explicitly trusted. This is a one-time host setup when using the global CLI:

```sh
npm install -g model-worklog
model-worklog supervisor start
model-worklog workspace trust /absolute/path/to/your-agent-workspace
```

The SDK reads the local credential from `MODEL_WORKLOG_HOME` (or `~/.model-worklog`) and connects only to loopback HTTP. The supervisor performs the final redaction before evidence is stored or exported.

Your agent application's backend can call `session.followEvents()` to send the
same committed redacted events to its terminal, desktop app, or authenticated
site UI. Keep the local token out of browser code; forward events through the
application's own authenticated server channel.

```ts
import { readFile } from 'node:fs/promises';
import { LocalSupervisorClient } from 'model-worklog-sdk';

const client = await LocalSupervisorClient.fromLocalEnvironment();
const session = await client.startSession({
  workspacePath: process.cwd(),
  actor: 'my-agent-adapter',
  title: 'Fix the failing parser test',
});

await session.userMessage('Fix the failing test.');
await session.plan('Inspect the test and implementation, then make the smallest repair.');
await session.reasoningSummary('The assertion likely has an outdated expected value.');
await session.runTool({ tool: 'read_file', arguments: { path: 'src/app.ts' } }, () => readFile('src/app.ts', 'utf8'));
await session.fileRead({ path: 'src/app.ts', tool: 'read_file' });
await session.fileChanged({ path: 'src/app.ts', operation: 'modified' });
await session.summary('The failing assertion uses an outdated expected value.');
await session.complete();
```

External SDK integrations are labelled as agent-reported. Model Logger never presents them as direct observation. The Codex App Server relay directly receives the documented vendor stream, so its updates are labelled as coming from the AI integration. Missing or unsupported details are shown as unavailable with a plain explanation.

Token counts are shown only when an AI provider or integration returns them. The **Tokens Used** section is last in the bottom log panel and updates as soon as a provider usage update arrives. Codex reports them through its App Server when available. For OpenAI, Anthropic, Gemini, and other SDK integrations, call `reportProviderUsage()` with the completed provider response. `npm run demo:live` includes a clearly simulated provider response so you can verify the live token section; local-only runs show `not reported` instead of guessing.

See [Integration](docs/integration.md), [Evidence](docs/evidence-model.md), and [Adapter support](docs/adapter-capability-matrix.md).

For a runnable local product-model example and log-inspection walkthrough, see [Dummy product-model integration](docs/dummy-model-demo.md).

## Development and releases

```sh
npm ci
npm run release:check
npm run extension:test
```

`release:check` validates all npm package tarballs and creates an installable VSIX. See [the release guide](docs/releasing.md) before publishing to npm or the VS Code Marketplace.

## Privacy And Storage

- Evidence is redacted before it is written, returned, searched, or exported.
- The local supervisor binds only to loopback and requires a per-installation token for session data and changes.
- Absolute filesystem paths are scrubbed from exported evidence bundles.
- CLI exports are written with owner-only permissions on POSIX systems, including when overwriting an existing file.
- No workspace upload, telemetry, or hosted service is enabled by default.
- Evidence bundles are readable JSON with a canonical SHA-256 manifest for local integrity checks.

## License And Contributions

Model Logger is open source under the [MIT License](LICENSE). Contributions are
welcome; see [CONTRIBUTING.md](CONTRIBUTING.md) for local validation steps.

See the [security model](docs/security-model.md) for protections, operating
requirements, and limitations.
