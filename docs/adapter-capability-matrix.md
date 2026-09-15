# Adapter Support

Model Logger supports any integration that can call `model-worklog-sdk`. The common event format and evidence rules are provider-neutral; direct process control is intentionally adapter-specific. The SDK records visible conversation, high-level plans, readable reasoning summaries, tools and results, files, commands, tests, and provider usage when the host runtime reports them.

| Integration | Current Support | Evidence Grade |
| --- | --- | --- |
| Codex App Server | Supervisor launches one task, follows documented JSON-RPC events, supports interruption and time/token limits. | `observed-native` for documented vendor events; `observed-boundary` for relay process lifecycle. |
| Claude Code | SDK mapper accepts documented hook payloads. | `model-declared` because an external hook client sends the data. |
| GitHub Copilot | Use the SDK from an agent/tool integration that receives visible Copilot events. VS Code Copilot Chat has no passive capture path. | `model-declared` unless a future direct supported relay observes the event. |
| OpenAI and OpenAI-compatible | Use the SDK around the agent loop and submit the final response to the OpenAI usage normalizer. | `model-declared`. |
| Gemini | Use the SDK around the agent loop and Gemini usage normalizer. | `model-declared`. |
| Cursor and other agents | Use the SDK with the agent's documented hook, API, or framework callback surface. | `model-declared` unless a future direct relay supports it. |

Missing vendor visibility is always retained as `unknown`; it is never guessed from output or agent branding. Raw private chain-of-thought is never retained; only a provider-visible reasoning summary may be recorded.
