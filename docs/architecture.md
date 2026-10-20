# Product Goal And Architecture

Build a shippable, SDK-first local tracing product that developers wrap around
their agents to inspect observable model, tool, MCP, retrieval, and workflow
activity. Make integration simple without compromising application behavior,
privacy, or evidence provenance. VS Code is a review client; a CLI is optional.

"All logs" means all events emitted by configured instrumentation within its
published limits. Uninstrumented activity, provider-hidden reasoning, and lost
events cannot be reconstructed. Never represent partial capture as complete.

## Layers

| Layer | Responsibility | Location |
| --- | --- | --- |
| Contracts | Versioned validation, bounded JSON, privacy policy | `packages/event-schema/src/trace.ts`, `privacy.ts` |
| SDK domain | Span lifecycle, context, streams, explicit MCP interception | `packages/adapter-sdk/src/tracing/` |
| SDK infrastructure | Export strategy, bounded delivery, optional private spool | SDK `http.ts`, `processor.ts`, `diskSpool.ts` |
| Collector application | Authentication, role/project authorization, intake | `apps/local-supervisor/src/traces/application/` |
| Collector infrastructure | SQLite transactions, hashed credentials, cursors | Collector `infrastructure/` |
| Protocol adapter | Standard OTLP/HTTP JSON and protobuf mapping | Collector `otlp/` |
| Presentation | Role-gated queries, span tree, safe export | `apps/vscode-extension/src/trace*.ts` |
| Retrieval domain | Query strategies, evidence composition, ports/interceptors | Collector `domain/queryPlanner.ts`, `logQuery.ts`, `logAnswer.ts` |
| Retrieval application | Scoped read orchestration, admission, optional generation | Collector `application/logQuery.ts` |
| Retrieval infrastructure | Transactional FTS5, exact SQL, optional provider strategy | Collector `infrastructure/log*.ts` |

Business logic depends on exporter/repository/credential interfaces. No SDK
global provider or monkey-patch is installed. Each logger owns its async context.

## Guarantees And Limits

- Default capture is metadata-only. Content requires both SDK and operator opt-in.
- Redaction happens before SDK buffering/spooling and again before collector writes.
- Default telemetry failure policy preserves application results and exceptions.
- Queue, batch, request, span, spool, and store limits are explicit. Inspect `shutdown()` results.
- Stable span IDs/revisions provide idempotent replay. Delivery is not exactly-once.
- SQLite transactions keep snapshots and summaries consistent; legacy JSONL sessions remain separate.
- Writer, reader, and admin permissions derive from credentials, never caller role headers.
- External SDK/OTLP evidence is `model-declared`. Authentication is not proof of execution.
- The collector is loopback-only. Distributed applications need a collector in their own trusted runtime; do not port-forward it.
- Exports contain redacted retained evidence and gap warnings, not a signed compliance attestation.

## Implemented Milestones

1. Failure-isolated SDK operations and preserved tool results.
2. Validated trace, privacy, and authorization contracts.
3. Nested spans, streams, MCP client wrapping, OpenTelemetry export, bounded delivery, optional spool.
4. Transactional collector, scoped expiring/revocable credentials, pagination, quotas, retention, OTLP/HTTP.
5. VS Code setup, trace inspection, role-gated actions, and bounded complete-page export.
6. Local trace-log retrieval with exact counts, source-linked evidence, optional model synthesis, and CLI/browser/native editor workflows.

The retrieval application depends on repository, admission, and generation ports.
Persistence interceptors maintain an external-content FTS5 read index atomically
with existing span writes and retention. Query strategies separate exact tool
analytics from failed-span and lexical evidence retrieval. The default answer
strategy is local; explicit model synthesis sees only bounded authorized evidence
and falls back on provider/citation failures. See [retrieval](log-retrieval.md).

## Further Qualification

Before making broader claims, validate more real framework/provider versions,
measure sustained-load overhead, and qualify Windows ACLs. A standalone MCP
transport proxy, gRPC/compressed OTLP, sampling controls, additional agent-hook
harnesses, signed external checkpoints, and hosted multi-tenant operation are
not implemented. Existing MCP/OTel instrumentation can feed the current collector.