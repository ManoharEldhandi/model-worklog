# Evidence Model

Model Logger records what an instrumented source supplies, not everything an
agent did. A trace, a usage counter, and an authenticated writer are different
kinds of evidence; none alone proves completeness, correctness, or actor identity.

## Trace Records

The shared `TraceSpan` contract contains project/trace/span IDs, optional parent
and links, service/name/kind, timestamps, state, revision, attributes, events,
optional usage, and a `capture` report. The collector adds `receivedAt`, a storage
`sequence`, and `evidenceGrade: 'model-declared'`. Producer timestamps are not
trusted clock attestations; receipt order need not be execution order.

| Ingestion path | Lifecycle fidelity |
| --- | --- |
| SDK `trace`, `wrap`, `stream` | Running revision 1 and terminal revision 2; cancellation/shutdown can produce `interrupted`. |
| JS `ModelLoggerSpanExporter` | Completed OTel spans reconstruct start/final snapshots at export time, not live starts. |
| OTLP HTTP | Final spans stored as revision 1; timestamps floored from nanoseconds to milliseconds; unknown message fields ignored. |

The collector retains the highest accepted revision for a span identity, not a
full revision journal. Stale revisions and identical retries are duplicates;
conflicting content at the current revision is rejected. A valid acknowledgement
covers the submitted snapshots, not uninstrumented work or crash-lost snapshots.

`capture` records mode, redacted/truncated field counts, dropped events, and
limitations. Counts can accumulate across privacy stages. Queue drops, sampling,
upstream omissions, crashes, missing parents, and abandoned streams can all limit
coverage. `completed` describes retained span state, not the whole application.

## Evidence Grades

| Grade | Meaning and scope |
| --- | --- |
| `model-declared` | All SDK/OTLP traces, MCP wrapper spans, external session reports, and hook submissions. The collector did not independently observe the claimed action. |
| `observed-native` | Legacy supervisor-owned Codex/Copilot task relays directly receive documented vendor events. Not a grade for arbitrary SDK or OTLP submissions. |
| `observed-boundary` | Legacy supervisor observation of its managed process, output, or workspace snapshot; not proof that an agent caused every effect. |
| `computed` | Legacy deterministic supervisor derivation, such as session lifecycle metadata. |
| `unknown` | A legacy event explicitly lacks supported evidence. In traces, missing fields remain absent and coverage is limited rather than fabricated. |

Interactive Copilot CLI hooks **and externally submitted final usage** are
`model-declared`, even when that usage originated in a vendor telemetry file.
An actor name, service label, provider response ID, or OTel resource is not a
signed identity. Authentication authorizes a project; it does not authenticate
the truth of its submitted events.

## Usage And Completeness

Usage provenance is separate from evidence grade: `provider-reported`,
`computed-from-provider-fields`, or `adapter-reported`. SDK normalizers use only
supplied provider fields; OTel mappings use recognized usage attributes. Missing
input/output/total counters stay **unknown**, not zero or an estimated bill.
Reasoning-token counts do not expose reasoning text.

Trace totals aggregate terminal `model` spans, deduplicating matching
provider/request IDs when present. Without those IDs, duplicate reports on
different spans may still double-count. Partial counts and conflicting usage
mark the summary incomplete; a visible total can therefore be partial. Do not
sum cumulative stream chunks or every parent/child usage field independently.

The summary's `incomplete` flag covers known structural, lifecycle, truncation,
and model-usage gaps. Its absence cannot prove all work was instrumented.
Use counts together with capture reports and SDK delivery status. Bounded queues,
retry exhaustion, and asynchronous spooling can lose telemetry; replay is not
exactly-once delivery.

## Readable Activity Projection

### Semantic Backend Logs

User-facing consumers should read semantic snapshots from
`GET /v1/sessions/:id/log` or the scoped
`GET /v2/traces/:traceId/log?projectId=...` endpoint, not reconstruct a log from
raw events. The SDK exposes `session.getLog()`, `session.followLog(...)`,
`client.getLog(sessionId)` and `client.getTraceLog(projectId, traceId, options)`.
The extension and CLI use the same semantic processor. Existing raw endpoints and
legacy exports remain available as evidence/debug interfaces.

A snapshot contains ordered `entries`, ready-to-use `lines`, per-entry
`operations`, one `usage` summary, resource/action `summary`, `capture` metadata,
separate `diagnostics`, and a cursor. Refresh replaces the snapshot; it does not
append duplicate entries. Start/stop/turn/model transport notifications and
unavailable-reasoning notices belong in diagnostics/capabilities, not in the
ordinary action stream. Failed operations and explicit user-facing errors remain
visible. Session lifecycle is a snapshot state rather than duplicate completion
rows. File and directory counts include successful observations, not failed reads.

Usage is a single stable entry that evolves as request reports arrive. Explicit
provider/request identities deduplicate reports; conflicting identities, missing
counters, overflow and incomplete trace pages remain partial/unknown. Numeric
reasoning tokens are separate from reasoning text. The native Copilot relay reads
its documented metadata exporter while running, not only after exit. Recorded
usage retains which categories the provider actually supplied.

Readable provider-exposed reasoning and message deltas are correlated, assembled
live, and replaced by explicit final snapshots without duplicating the final
text. Commentary, reasoning, tool actions, results and response remain ordered.
Parallel/sub-agent work retains its actor scope; it is not merged with another
agent's identically named tool. Tool results stay linked to their particular
operation even when several reads share one segment. The final chat response is
not concatenated with earlier progress messages.

Copilot readable reasoning capture is explicitly opt-in (`captureReasoning`).
Only documented exposed fields are captured; opaque/encrypted reasoning is never
decoded. The [official Copilot event reference](https://github.com/github/copilot-sdk/blob/main/docs/features/streaming-events.md)
defines these fields. Other producers may emit an explicitly opted-in
`agent.reasoning.summary` span event with `visibility: 'provider-exposed'` and a
`summary`; normal SDK/collector privacy still applies. No text is invented when
a provider does not expose it. These are producer statements, not independent
proof that an explanation is complete or faithful to internal computation.

### Low-Level Projection

The schema package and SDK export `buildSessionActivity`, `buildTraceActivity`, and
`formatActivityText`. These deterministic functions turn captured records into
version-1 `ActivityEntry` objects. The projection is not another evidence grade,
an AI-generated interpretation, or a replacement for source events and spans.

Each entry carries a stable ID, category, status, actor/service, start and optional
end timestamps, resources, named tools/MCP servers, details, capture warnings,
and source references. Session references retain session/event IDs, sequence,
correlation, timestamp and evidence grade. Span references retain project, trace,
span and revision IDs, with parent relationships on entries. Preserve these
references when indexing or exporting; a readable heading alone is not evidence.

- Consecutive file reads become one segment with unique paths and repeated-read
	counts. Tool start/read/result triples share that segment when their explicit
	correlation matches. Every source reference and captured result remains available.
- Grouping respects actor, evidence, session/trace and parent boundaries. Commentary,
	another action, failure, or a gap of more than 30 seconds after the preceding
	segment ends creates another segment. Overlapping sibling reads may group.
- Counts are derived from retained operations, not a target group size. SDK file
	tools can explicitly set `file.operation` and `file.path`, with optional
	`file.type`; the tool can have any name or MCP server. Supported operations are
	`read`, `created`, `modified`, `deleted` and `changed`. Explicit semantics take
	precedence over known read-tool names and apply only to tool spans. These fields
	still require both privacy policies to allow them; formatting does not widen
	capture. Other operations remain their own typed or generic activities.
- Tools and commands pair only through explicit correlation within their source
	scope. Missing or reused correlations are not guessed. Failed reads stay
	separate; missing outcomes remain unknown, not successful or failed by inference.
- Adjacent output fragments from the same correlated stream join without invented
	newlines. Explicit `delta: true` message, plan and visible-summary fragments join
	only with a matching correlation. An explicit `final: true` snapshot replaces
	that stream's displayed text, retaining every source reference. Distinct messages,
	tests, changes and capture gaps remain separate. Provider-hidden reasoning is
	not supplied.
- Session times describe collector receipt, not independently verified execution
	times. A grouped time range is the range of captured observations; it is not
	the sum of operation durations. Trace times remain producer-supplied span times.
- Presentation applies additional privacy filtering and bounded detail strings.
	Explicit warnings identify shortened detail. Expanding a row is not redaction;
	it reveals more of the same retained, filtered presentation.

The dashboard and VS Code use expandable chronological activities. The dashboard
also provides type/search filters and a separate SDK span view. CLI pretty logs
use the same projection; pretty watch holds the open segment until an action
boundary or final snapshot. CLI JSON/JSONL remain canonical event outputs.

Dashboard downloads include activities alongside source events and captured spans.
VS Code trace exports include activities alongside their retained spans, with
`metadata.activitySchemaVersion: 1`. Existing legacy evidence bundles remain
unchanged. These exports still do not establish complete underlying execution.

A later retrieval layer can select by category, resource path, tool/server, time,
status and project, then resolve source references for citations and context.
Do not discard original records, infer missing content from group counts, or
index provider-hidden reasoning. Retrieval and embeddings are not implemented by
this presentation layer.

## Privacy And Export

SDK content requires application and operator opt-in. Redaction runs before SDK
queue/spool persistence and again at collector intake. Spools contain redacted
snapshots, not a raw archive. Redaction is best effort; metadata and allowed
attributes can still be sensitive. Never submit provider-hidden reasoning.
Adapters may retain explicitly enabled, readable provider-exposed reasoning or
visible summaries, not inaccessible or encrypted private state. See
[security](security-model.md).

VS Code **Export Captured Trace JSON** contains retained spans and capture metadata,
including `underlyingExecutionComplete: false`. It collects available pages with
bounds, but concurrent writes mean pagination is not a point-in-time snapshot.
It is not a signed audit bundle; absolute paths or sensitive prose may remain.
Review it before sharing.

Legacy session evidence bundles separately include a SHA-256 audit manifest and
export redaction metadata. The manifest checks consistency with those hashes;
it is **not a signature**, proof of authorship, or protection against someone
rewriting both content and manifest. Neither format implies compliance readiness.
See the [capability matrix](adapter-capability-matrix.md) for source-specific limits.
