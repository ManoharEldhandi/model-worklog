# Capture Capabilities

Prefer explicit SDK or OTel instrumentation. These capabilities describe the
upcoming 0.2.0 checkout, not a claim that new tracing packages are already
published. All tracing paths use the same-host collector; no CLI is required.

## Tracing Paths

| Integration | Captured surface | Limits and evidence |
| --- | --- | --- |
| TypeScript/JavaScript SDK | `createLocalModelLogger`; `trace`, `wrap`, and `stream` around application operations. | Explicit instrumentation only; bounded snapshots, metadata by default; `model-declared`. |
| OTel JS | `ModelLoggerSpanExporter` on the application's provider; compatible with supplied OpenInference/OpenLLMetry spans. | No automatic instrumentation; starts reconstructed from completed spans; `model-declared`. |
| Python or other OTLP producers | Official OTLP HTTP exporters to `/v1/traces`, JSON or protobuf. | Final spans only; at most 100 spans/2 MiB; no compression/gRPC; `model-declared`. |
| MCP client | `instrumentMcpClient` wraps tool calls/listing, resource reads/listing, and prompt get/list. | Only the six wrapped client methods; no global patches or server internals; `model-declared`. |
| OpenAI, OpenAI-compatible, Anthropic, Gemini | `recordProviderUsage` normalizes supplied response fields; custom mappings cover other shapes. | A usage helper, not automatic interception. Missing counts stay unknown; SDK evidence remains `model-declared`. |
| VS Code trace views | Project selection, span trees, captured details, usage, capture warnings, JSON export. | Reads retained data; does not observe arbitrary Chat sessions. Reader/admin can browse; writer-only cannot. |

SDK content requires both application `privacy` and operator `tracePrivacy`
opt-in, plus explicit result/chunk serialization. OTLP upstream capture must be
configured separately and is filtered by collector privacy. No path reveals
provider-hidden reasoning. See [integration](integration.md) and the
[SDK reference](../packages/adapter-sdk/README.md) for examples.

## Existing Agent Compatibility

These optional legacy session adapters remain available. They are not new trace
capture features or prerequisites for SDK integration; the CLI retains its
existing compatibility commands.

| Integration | Existing surface | Evidence and gaps |
| --- | --- | --- |
| Codex App Server task | Supervisor-owned JSON-RPC relay, cancellation and run limits. | Documented vendor events `observed-native`; managed process lifecycle `observed-boundary`. |
| Copilot CLI prompted task | Supervisor-owned JSONL relay and metadata-only telemetry file. | Directly received vendor events/usage `observed-native`; managed process lifecycle `observed-boundary`. |
| Copilot CLI interactive | Terminal launcher, CLI hooks, externally submitted final telemetry usage. | Hooks **and final usage** are `model-declared`; coverage depends on actual hook/telemetry output. |
| Copilot CLI personal hook | Model Logger-owned CLI hook bridge while enabled. | `model-declared`; no main assistant response or provider token counters in those hook payloads. |
| Claude Code | Existing SDK mapper for documented hook payloads. | Requires an explicit hook client; `model-declared`, not passive observation. |
| VS Code agent hooks | VS Code documents an opt-in hook surface. | A new VS Code Chat hook adapter is **not implemented** here; do not confuse it with Copilot CLI hooks. |
| Cursor/other harnesses | Application-owned SDK, tool wrapper, documented hook, or framework callback. | No generic native relay is promised; supplied activity is `model-declared`. |

## Qualification

[VS Code hooks](https://code.visualstudio.com/docs/agent-customization/hooks) and
other harness hooks vary by version, configuration, policy, and payload. A
documented hook surface is not universal message, tool, usage, or reasoning
visibility. Unsupported or missing detail stays unknown; branding is not evidence.

No passive filesystem/terminal inference is promoted to agent evidence. A provider
token count is not billing verification, and an audit manifest is not signed
identity. Cross-platform filesystem/Windows ACL qualification remains incomplete;
no compliance or performance benchmark claim is made. See
[evidence](evidence-model.md) and [security](security-model.md).
