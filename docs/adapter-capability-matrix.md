# Adapter Support

Model Logger supports any integration that can call `model-worklog-sdk`. The common event format and evidence rules are provider-neutral; direct process control is intentionally adapter-specific.

| Integration | Current Support | Evidence Grade |
| --- | --- | --- |
| Codex App Server | Supervisor launches one task, follows documented JSON-RPC events, supports interruption and time/token limits. | `observed-native` for documented vendor events; `observed-boundary` for relay process lifecycle. |
| Claude Code | SDK mapper accepts documented hook payloads. | `model-declared` because an external hook client sends the data. |
| GitHub Copilot | Use the SDK with available hooks or integration events. | `model-declared` unless a future direct supported relay observes the event. |
| Gemini | Use the SDK and Gemini usage normalizer. | `model-declared`. |
| Cursor and other agents | Use the SDK with the agent's documented hook, API, or framework callback surface. | `model-declared` unless a future direct relay supports it. |

Missing vendor visibility is always retained as `unknown`; it is never guessed from output or agent branding.
