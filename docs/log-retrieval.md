# Log Retrieval And Answers

This feature is available from the source branch with matching locally built
packages. It does not imply a new npm or Marketplace publication.

Ask questions over retained, redacted trace spans without loading entire logs
into a prompt. Tool questions use exact SQL aggregates. Other questions retrieve
bounded evidence using SQLite FTS5 and return source-linked excerpts. Optional
OpenAI-compatible synthesis can interpret those excerpts with explicit consent.

## Browser Demo

From the repository root, use Node.js >=22.13:

```sh
npm ci
npm run build
MODEL_WORKLOG_DEMO_PROVIDER=offline-demo npm run demo:web
```

1. Open the printed loopback URL and select **Ask logs**.
2. Choose **Record sample**. This performs actual local file reads, a search,
   and a handled stock-validation failure, without a model account.
3. The initial answer shows **122 tool calls**: `read_file` 120,
   `search_workspace` 1, and `validate_stock` 1. Only eight evidence records
   are returned by default; counts still cover the whole selected trace.
4. Ask **How many times was read_file used?**, then **What failed?**.
   Expand a source and choose **Open source** to inspect its retained span.
5. Change scope, tool, query type, or inclusive start-time filters. Export an
   answer as JSON. Unknown tools and empty scopes return no captured evidence,
   not a claim that nothing happened outside instrumentation.

The existing workspace-review flow remains available. Copilot tool lifecycles
in this demo are projected into deduplicated tool spans with references to the
original session/event IDs, including incomplete and failed calls. Raw legacy
session events elsewhere are not silently imported or counted.

The dashboard keeps credentials server-side, rejects cross-origin requests,
allows one capture at a time, and caches the newest 20 completed/current run
views. Its isolated temporary collector and workspace are removed on shutdown.
Its local HTTP proxy is for demos, not a remotely exposed deployment.

## CLI And VS Code

```sh
npm run cli -- ask "What tools were used?" --project default --format pretty
npm run cli -- ask "How many times was read_file used?" --project default
npm run cli -- ask "What failed?" --project default --tool validate_stock
npm run cli -- ask "inventory validation" --project default --intent search --limit 5
```

Use the project ID actually instrumented by your application. Optional flags
include `--trace`, `--since`, `--until`, `--tool`, `--intent`, `--limit`, and
`--synthesis`. JSON and JSONL outputs retain counts, source identities, revisions,
capture reports, coverage notes, and the retrieval/generation strategy.

The CLI uses the existing local credential lookup. Prefer a scoped reader
provided privately through `MODEL_WORKLOG_TOKEN`; otherwise the local operator
credential is used. A writer credential cannot query logs.

In VS Code, enable Model Logger, select the desired Traces project, and run
**Model Logger: Ask Captured Logs** from the Traces toolbar or command palette.
Choose the project or selected trace scope. Answers appear in **Model Logger
Answers**; the source picker opens the exact retrieved evidence snapshot,
independently of sidebar pagination. The command uses local answers and does not
persist question history or enable content capture.

## API

`POST /v2/logs/query` requires a reader or admin credential in the existing
`x-model-worklog-token` header and an explicit authorized project:

```json
{
  "schemaVersion": 1,
  "projectId": "default",
  "question": "How many times was read_file used?",
  "intent": "auto",
  "synthesis": "extractive",
  "limit": 8
}
```

Optional `traceId`, `toolName`, `since`, and `until` narrow the scope. Time filters
compare span start times inclusively, not completion or receipt times. Use ISO
UTC timestamps. `toolName` matches exactly, ignoring ASCII case; a plainly named
tool in a usage question is also recognized. Use an explicit filter when a name
is ambiguous. `intent` can force `tools`, `failures`, or lexical `search`.

Responses include exact scoped totals, up to 100 tool groups, up to 20 evidence
records, `[S1]` citation IDs, trace/span IDs, revisions, excerpts, capture reports,
and explicit limitations. Source spans can be read using the existing paginated
`GET /v2/traces/:traceId?projectId=...` endpoint. Only the latest revision is
retained; a later read may have advanced or been deleted since the query snapshot.

Errors preserve the collector's contract: `400` invalid input, `401` invalid or
expired credentials, `403` wrong role/project/origin, `429` query budget or busy
storage, and `507` storage capacity. Query strings and unknown fields are not
accepted. Queries do not write captured log payloads or mint credentials.

## Optional Model Synthesis

Nothing is sent to a model by default. Configure the standalone supervisor with
both `MODEL_WORKLOG_RAG_URL` and `MODEL_WORKLOG_RAG_MODEL`; provide an optional
`MODEL_WORKLOG_RAG_API_KEY` through the operator's secret manager. The endpoint
must use HTTPS or loopback HTTP, with no URL credentials, query, or fragment.
Redirects are refused. Embedded collectors can inject a `LogAnswerGenerator` or
use the exported `OpenAiLogAnswerGenerator` strategy.

```sh
export MODEL_WORKLOG_RAG_URL='http://127.0.0.1:11434/v1/chat/completions'
export MODEL_WORKLOG_RAG_MODEL='your-installed-model'
npm run supervisor
```

Then explicitly request `"synthesis": "model"` or pass `--synthesis model`.
The browser demo offers **Model interpretation** when its existing
OpenAI-compatible provider is configured. That checkbox sends the question and
bounded redacted evidence to that configured provider, which may be remote.
Metadata-only capture and excluded content remain excluded.

Tool-count answers never use the model. Empty retrieval does not invoke it.
Generation has an eight-second deadline, two concurrent provider slots, a 64 KiB
response limit, strict JSON output, and validation of every returned citation ID.
Provider failure, timeout, malformed output, or unknown citations fall back to
the local evidence answer without exposing provider error bodies or credentials.
Model interpretations are labelled and can still be wrong: citation identity
validation is not proof that every statement follows from its source.

## Architecture And Operational Limits

- **Domain:** immutable query plans, pluggable planning strategies, evidence
  composition, and repository/admission/generation/interceptor interfaces.
- **Application:** validated scope, admission, retrieval orchestration,
  optional synthesis, cancellation, and answer/citation validation.
- **Infrastructure:** parameterized SQLite analytics, an external-content FTS5
  index, bounded local admission, and the optional HTTP model strategy.
- **Adapters:** the existing authenticated HTTP boundary, CLI, native VS Code
  command, and same-origin dashboard proxy. Authentication is not reimplemented.

Persistence interceptors update the index in the same transaction as span
revisions, deletion, and retention. Conflicts and failed batches roll back the
index too. First startup indexes existing spans transactionally; later startups
reuse it. FTS secure deletion is enabled. Indexes need extra disk headroom inside
the collector's existing physical page ceiling; capacity errors are explicit.

Some supported SQLite builds, including stock Node 22.13.0, do not include FTS5.
They use a disclosed `sqlite-scan` strategy: bounded literal-term matching ordered
by recency, not BM25 ranking. It is slower on large stores. Exact tool aggregates
remain unchanged. Writes on a non-FTS runtime mark an existing index dirty; a
later FTS-capable startup rebuilds it transactionally before indexed reads.

FTS5 is **lexical**, not an embedding/vector semantic search engine. Queries use
at most 12 distinct terms of 80 characters, safely quoted rather than interpreted
as FTS syntax. Full text is already redacted at intake; retrieval does not bypass
privacy or recover discarded content. Questions are limited to 2,000 characters,
citations to 20 bounded excerpts, and local admission to 30 queries per credential
per minute with at most 1,024 active credential windows. Admission affects only
queries, not capture, authentication, or normal trace reads.

Exact tool counts are distinct retained `kind: tool` span identities, including
running, interrupted, failed, and completed attempts. Revisions/retries of the
same span are not additional calls. Separate spans representing the same external
call cannot be deduplicated automatically. Tool names use a bounded `tool.name`
attribute when valid, otherwise the span name. Evidence is model-declared, not
independent proof of execution; uninstrumented work and raw legacy sessions are
outside this corpus. Existing retention, redaction, and partial capture can limit
answers. No universal capture, sustained-load benchmark, Windows ACL parity,
remote multi-tenancy, or compliance guarantee is implied.
