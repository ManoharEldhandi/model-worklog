# Log Data

Model Logger stores structured JSON internally and renders it as readable session activity in VS Code and the CLI. Every saved update has a supervisor-assigned sequence, timestamp, source, type, source label, privacy metadata, and JSON payload.

## Source Labels

| Grade | Meaning |
| --- | --- |
| `observed-native` | A supported vendor interface directly emitted the fact to the supervisor relay. |
| `observed-boundary` | The supervisor observed a local process, command, output stream, filesystem effect, or Git snapshot. |
| `computed` | The supervisor deterministically derived session lifecycle metadata. |
| `model-declared` | An external SDK or adapter reported the fact; Model Logger did not independently observe it. |
| `unknown` | The integration did not provide the detail, or it was hidden, shortened, malformed, or unsupported. |

Source labels explain where a detail came from, not how useful it is. In the VS Code sidebar they are shown in plain language, such as “from the AI integration” or “reported by the agent.” An SDK report is never presented as direct observation by Model Logger.

## What Is Retained

Supported integrations may record visible assistant messages, plans, readable reasoning summaries, tool calls, command activity/output, reviewed files, edits, test results, token usage, adapter failures, and session lifecycle.

Private raw reasoning is not retained. When an AI provides raw reasoning, Logger hides it. A provider-supplied readable reasoning summary can be retained separately when exposed.

## Redaction And Export

Secrets in common credential forms and sensitive structured fields are hidden before Logger stores or returns a log. The built-in patterns cover common bearer, GitHub, GitLab, npm, Slack, OpenAI-style, and AWS credentials; they are defense in depth, not a guarantee that every secret format is recognized. Output has fixed limits and reports when it is shortened. Downloaded JSON also hides absolute paths and includes a SHA-256 integrity manifest. Verification detects modified content with its original manifest; it is not a signed provenance system.
