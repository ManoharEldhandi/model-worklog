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

## Privacy And Export

SDK content requires application and operator opt-in. Redaction runs before SDK
queue/spool persistence and again at collector intake. Spools contain redacted
snapshots, not a raw archive. Redaction is best effort; metadata and allowed
attributes can still be sensitive. Never submit provider-hidden reasoning.
Legacy adapters may retain a separately exposed, user-visible reasoning summary,
not private chain-of-thought. See [security](security-model.md).

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
