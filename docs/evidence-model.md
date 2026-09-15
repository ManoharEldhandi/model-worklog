# Evidence

Model Worklog stores structured JSON internally and renders it as readable session text in VS Code and the CLI. Every retained event has a supervisor-assigned sequence, timestamp, source actor, event kind, evidence grade, redaction metadata, and JSON payload.

## Evidence Grades

| Grade | Meaning |
| --- | --- |
| `observed-native` | A supported vendor interface directly emitted the fact to the supervisor relay. |
| `observed-boundary` | The supervisor observed a local process, command, output stream, filesystem effect, or Git snapshot. |
| `computed` | The supervisor deterministically derived session lifecycle metadata. |
| `model-declared` | An external SDK or adapter reported the fact; Model Worklog did not independently observe it. |
| `unknown` | The integration lacks the fact, it was redacted, truncated, malformed, or unsupported. |

Grades describe provenance, not usefulness. A client declaration is never promoted to native or boundary observation.

## What Is Retained

Supported integrations may record visible assistant messages, plans, readable reasoning summaries, tool calls, command activity/output, reviewed files, edits, test results, token usage, adapter failures, and session lifecycle.

Private raw reasoning is not retained. A raw-reasoning stream becomes a `redacted` evidence gap, while a provider-supplied readable reasoning summary can be retained separately when exposed.

## Redaction And Export

Secrets in common credential forms and sensitive structured fields are redacted before durable storage. Output has fixed limits and records truncation when it occurs. Exported bundles additionally scrub absolute paths and include a canonical SHA-256 manifest. Hash verification detects modified content with its original manifest; it is not a signed provenance system.