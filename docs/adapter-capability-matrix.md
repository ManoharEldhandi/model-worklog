# Adapter Support

Model Logger supports any integration that can call `model-worklog-sdk`. The common event format and evidence rules are provider-neutral; direct process control is intentionally adapter-specific. The SDK records visible conversation, high-level plans, readable reasoning summaries, tools and results, files, commands, tests, and provider usage when the host runtime reports them.

| Integration | Current Support | Evidence Grade |
| --- | --- | --- |
| Codex App Server | Supervisor launches one task, follows documented JSON-RPC events, supports interruption and time/token limits. | `observed-native` for documented vendor events; `observed-boundary` for relay process lifecycle. |
| GitHub Copilot CLI task | Supervisor launches one prompted task and follows its documented JSONL event output plus metadata-only OpenTelemetry file export. | `observed-native` for documented visible messages, tools, results, and provider usage; `observed-boundary` for process lifecycle. Raw reasoning is not retained. |
| GitHub Copilot CLI interactive | VS Code launches the normal interactive terminal UI with a unique session ID and metadata-only OpenTelemetry file export, then submits final usage when the CLI exits. | Hook activity is `model-declared`; final documented provider usage is `observed-native`. Raw reasoning is not retained. |
| GitHub Copilot CLI personal hook | A Model Logger-owned user hook forwards documented lifecycle and tool hook payloads for normal CLI sessions while Logger is enabled. | `model-declared`; hook input does not include the main assistant response, raw reasoning, or provider token counters. Use the tracked interactive launcher for final usage. |
| Claude Code | SDK mapper accepts documented hook payloads. | `model-declared` because an external hook client sends the data. |
| GitHub Copilot | Use the SDK from an agent/tool integration that receives documented visible Copilot events. VS Code Copilot Chat itself has no passive event capture path. | `model-declared` for integration-supplied activity. |
| OpenAI and OpenAI-compatible | Use the SDK around the agent loop and submit the final response to the OpenAI usage normalizer. | `model-declared`. |
| Gemini | Use the SDK around the agent loop and Gemini usage normalizer. | `model-declared`. |
| Cursor and other agents | Use the SDK with the agent's documented hook, API, or framework callback surface. | `model-declared` unless a future direct relay supports it. |

Missing vendor visibility is always retained as `unknown`; it is never guessed from output or agent branding. Raw private chain-of-thought is never retained; only a provider-visible reasoning summary may be recorded.
