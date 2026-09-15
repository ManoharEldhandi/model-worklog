# Model Logger: Continuation Context

Read this file first when continuing work in this repository.

## Workspace

- Repository root: `/Users/meldhand/model-worklog`
- Runtime: Node.js 22 or newer and npm workspaces.
- Open the repository root in VS Code so the extension, supervisor, CLI, SDK, and shared schema are available together.

## Product

Model Logger is a local-first activity logger for AI agents. It records visible, observable work such as messages, tool calls, commands, command output, reviewed files, edits, tests, errors, and provider-reported token usage.

It does not retain private chain-of-thought, infer unobserved agent activity, or judge agent behavior. Missing evidence is represented explicitly as `unknown`.

## Architecture

```text
VS Code extension and CLI = local user interfaces
Local supervisor          = trusted runtime for session lifecycle, redaction,
                            storage, process control, exports, and adapters
Adapter SDK               = cooperative integration API for any Node-based
                            agent or application
Codex App Server relay    = directly supervised vendor integration
Event schema              = versioned shared protocol and evidence grades
```

The extension remains a client of the supervisor. Durable evidence, redaction, authentication, workspace trust, and process control belong in the supervisor.

## Evidence Rules

- Preserve evidence grades: `observed-native`, `observed-boundary`, `computed`, `model-declared`, and `unknown`.
- Use `unknown` when visibility is absent, malformed, unsupported, redacted, or truncated. Never infer a stronger fact from model branding or output alone.
- External SDK integrations can submit only `model-declared` and `unknown` evidence.
- Keep visible summaries only. Do not send raw reasoning or sensitive user data to the logger.
- Redact before persistence, responses, and exports. Upload is opt-in and is not implemented.

## Current Capabilities

- Loopback-only supervisor with per-installation token, private local storage, exclusive store lock, and explicit workspace trust.
- Durable JSON/JSONL sessions with redacted events, resumable filtered reads, bounded process output, Git snapshots, token usage, deterministic costs, and integrity-checked exports.
- Managed command logging with supervisor-owned cancellation. Running children receive `SIGTERM`, then `SIGKILL` after a short grace period when required.
- Direct Codex App Server logging with visible messages, summaries, tool activity, command activity, files, usage, time and token limits, and cancellation.
- Generic SDK client plus Claude hook and Codex event mappers for cooperative integrations.
- CLI and native VS Code log views for starting, reviewing, exporting, and deleting logs. VS Code lists sessions in the Model Logger sidebar and renders one selected session in the bottom Model Logger panel without taking editor focus. The selected view updates while the session runs and shows token totals when the connected AI reports them.
- Logs use a redacted task name from the Codex prompt, managed command, SDK `title`, or first recorded user request. The bottom view renders only sections that contain activity and puts visible assistant output in **Agent Response**.
- SDK `followEvents()` lets any Node application backend forward committed redacted session events to a terminal, desktop UI, or authenticated website channel.

## Product Limits

- Codex is the only direct-launch adapter. Other agents must integrate through the SDK or their documented hook surface and remain `model-declared`.
- Managed command logging observes the process boundary and workspace effects; it cannot discover tools used inside arbitrary child processes.
- Redaction is defense in depth, not a guarantee that every credential or sensitive-data format is recognized.
- The evidence manifest detects modification but is not a signature or authorship proof.

## Validation

Run from the repository root:

```sh
npm ci
npm test
npm run extension:test
npm run release:check
```

`release:check` verifies version alignment, tests, publishable package contents, a clean package build, and VSIX packaging. Do not commit, reset, or revert changes unless explicitly asked.

## Next Work

1. Run a manual smoke test with an installed, authenticated Codex CLI before publishing.
2. Add direct adapters only where a documented vendor stream can provide stronger evidence than SDK callbacks.
3. Expand redaction fixtures and model-price entries as supported providers and models are added.
4. Publish the four npm packages in dependency order, then publish the validated VSIX. See `docs/releasing.md`.
