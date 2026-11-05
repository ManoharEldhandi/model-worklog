# Log Retrieval And Answers

For Chroma HNSW, embeddings, BM25/RRF, application integration and measured
retrieval quality, use the [SDK RAG guide](sdk-rag.md). This page describes the
existing collector query endpoint and its compatibility clients.

The browser started by `npm run demo:web` uses SDK hybrid retrieval with exact
collector counts. The collector API sections below also apply to the existing
CLI and VS Code query commands.

This feature is available from the source branch with matching locally built
packages. It does not imply a new npm or Marketplace publication.

Ask questions over retained, redacted trace spans without loading entire logs
into a prompt. **Ask logs is a conversation**, not a tool-count dashboard. The
retrieval layer finds relevant requests, responses, files, tools, errors, timing,
models, and reported usage. The configured answer provider explains
that evidence in natural language and supports follow-ups. Exact aggregates come
from SQLite rather than being estimated from a prompt sample.

## Browser Demo

From the repository root, use Node.js >=22.13:

```sh
npm ci
npm run build
npm run demo:web
```

The default workspace agent is Codex with `gpt-5.6-terra` at low reasoning effort;
log answers use `gpt-5.6-luna`. Both use the existing CLI account, authenticated with
`codex login`. Model calls use that account. Copy `.env.example` to `.env` and
set `MODEL_WORKLOG_DEMO_WORKSPACE` to choose a local default without committing
a personal path. Workspace configuration exposes the folder name rather than
its absolute path; captured activity can still contain file paths.

1. Start with the sample, or enter a project folder and click **Use folder**.
   The sample uses a temporary copy; custom folders are edited directly.
2. In workspace chat, ask the agent to inspect code and run tests. The sample
   has one intentionally failing pricing test; a follow-up can fix it.
3. Open **Ask logs**, keep **Codex answers** enabled, and ask about failures,
   changed files, test output or the agent's reply. Use **All retained traces**
   to compare tasks. Each turn retrieves fresh evidence.
4. Open a citation to inspect the source. Exact counts are under the aggregate
   citation; **Open retained source** reads the stored span revision.
5. Use **Stop**, **Retry**, **New chat**, filters or **Export chat** as needed.

Switching folders resets retained traces, task views and conversation history;
no old-folder records are included in the new session. The selected folder is
never deleted on shutdown. Captured code, output and paths can be sensitive;
review exports before sharing them.

`MODEL_WORKLOG_DEMO_PROVIDER=copilot` retains the read-only Copilot workflow.
`offline-demo` exposes **Load offline example**, a scripted 122-tool-call
inventory workload for repeatable checks. That example is not a live agent run.
An OpenAI-compatible provider answers chat but does not execute workspace tasks.

The demo projects captured Codex/Copilot messages, file activity, readable summaries,
usage, and tool lifecycles into source-linked spans. Readable streaming assembly
is reused so deltas are not mistaken for separate replies. Only `kind: tool`
spans contribute to tool-call totals. Raw legacy sessions elsewhere are not
silently imported, and missing historical content cannot be reconstructed.

The dashboard keeps credentials server-side, rejects cross-origin requests,
allows one capture at a time, and caches the newest 20 completed/current run
views. Its temporary collector and sample copy are removed on shutdown; selected projects remain.
Its local HTTP proxy is for demos, not a remotely exposed deployment.

The browser keeps at most 20 conversation turns in memory and sends at most
12 recent user/assistant messages, 4,000 characters each and 16,000 characters
in total. Reloading or **New chat** clears that state. Completed-turn exports
include redacted questions, answers, scoped counts, snapshots, and citations,
not collector credentials. Review exports before sharing.

## CLI And VS Code

```sh
npm run cli -- ask "What tools were used?" --project default --format pretty
npm run cli -- ask "How many times was read_file used?" --project default
npm run cli -- ask "What failed?" --project default --tool validate_stock
npm run cli -- ask "inventory validation" --project default --intent search --limit 5
npm run cli -- ask "Summarize this run" --project default --synthesis model
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
  "question": "What did it answer?",
  "history": [
    { "role": "user", "content": "Summarize the last run." },
    { "role": "assistant", "content": "It reviewed the inventory files." }
  ],
  "intent": "auto",
  "synthesis": "model",
  "limit": 8
}
```

Optional `traceId`, `toolName`, `since`, and `until` narrow the scope. Time filters
compare span start times inclusively, not completion or receipt times. Use ISO
UTC timestamps. `toolName` matches exactly, ignoring ASCII case; a plainly named
tool in a usage question is also recognized. Use an explicit filter when a name
is ambiguous. `intent` can force `tools`, `failures`, or lexical `search`.

The standalone API defaults to `synthesis: extractive` for backwards-compatible
local evidence answers. Conversation history is bounded and stateless; only
`user` and `assistant` roles are accepted. History is redacted, and historical
citation IDs are removed from model context so they cannot masquerade as current
sources. It does not grant access to another project or trace.

Responses include exact scoped totals, models/services, time coverage, reported
token subtotals and completeness, up to 100 tool groups, and up to 20 evidence
records. `[A1]` cites the current exact aggregates; `[S1]` cites a retrieved span.
IDs belong to that answer, not to the whole conversation. Spans retain identity,
revision, capture reports, and explicit excerpt-truncation flags. Source spans
can be read using the existing paginated
`GET /v2/traces/:traceId?projectId=...` endpoint. Only the latest revision is
retained; a later read may have advanced or been deleted since the query snapshot.

Errors preserve the collector's contract: `400` invalid input, `401` invalid or
expired credentials, `403` wrong role/project/origin, `429` query budget or busy
storage, and `507` storage capacity. Query strings and unknown fields are not
accepted. Queries do not write captured log payloads or mint credentials.

## Optional Model Synthesis

For standalone Copilot answers, explicitly configure the operator process:

```sh
MODEL_WORKLOG_RAG_PROVIDER=copilot npm run supervisor
```

`MODEL_WORKLOG_RAG_MODEL` optionally selects an available Copilot model. This
does not turn on content capture or replace the existing local authentication.
Requests still need `synthesis: model`. The browser demo configures the selected answer provider separately from workspace execution.

For an OpenAI-compatible provider, configure the standalone supervisor with
both `MODEL_WORKLOG_RAG_URL` and `MODEL_WORKLOG_RAG_MODEL`; provide an optional
`MODEL_WORKLOG_RAG_API_KEY` through the operator's secret manager. The endpoint
must use HTTPS or loopback HTTP, with no URL credentials, query, or fragment.
Redirects are refused. Embedded collectors can inject a `LogAnswerGenerator` or
use the exported `OpenAiLogAnswerGenerator` or `CopilotLogAnswerGenerator` strategy.

```sh
export MODEL_WORKLOG_RAG_URL='http://127.0.0.1:11434/v1/chat/completions'
export MODEL_WORKLOG_RAG_MODEL='your-installed-model'
npm run supervisor
```

Model requests send the question, bounded recent history, redacted authorized
evidence, and exact aggregates to the selected provider. This includes count
questions: the AI explains the SQL results rather than counting sampled records.
An empty corpus can produce an honest insufficient-evidence reply, not an invented
answer. Metadata-only capture and excluded content remain excluded.

Copilot runs in a private empty temporary working directory with an empty
available-tool set, denied `shell`, `write`, and `url` permission kinds, disabled
built-in MCPs/custom instructions, no user-interaction tools, and no remote export.
Evidence is supplied through a bounded prompt because the qualified CLI prompt
mode does not consume piped JSON context. The installed CLI must support the required restrictions. Account history
sync is disabled with `--sync-session=off` on current CLIs or
`--no-remote-export` on older versions. The answerer does not reuse the workspace-review agent's tool permissions.
Copilot remains a trusted local provider process, not an OS sandbox; its own
authenticated account and private session storage are governed by Copilot.

Generation has a 45-second deadline, two concurrent slots per provider instance,
and a 64 KiB output limit. Copilot prompt context is capped at 128 KiB. Source
excerpts supplied to a model have a combined 24,000-character budget and disclose
shortening. OpenAI-compatible output uses strict JSON; Copilot uses Markdown with
validated citation IDs. Timeouts, provider errors, or unknown/missing citations
fall back to an explicitly labelled local evidence answer without exposing raw
provider errors or credentials. Cancellation aborts the HTTP request and signals
the Copilot child, with a bounded forced-stop grace period.

Markdown is rendered with Marked and DOMPurify. Scripts, images, event handlers,
unsafe links, forms, and embedded executable content are not rendered. Model
interpretations can still be wrong: citation validation checks source identities,
not whether every statement logically follows from its source.

## Architecture And Operational Limits

- **Domain:** immutable query plans, pluggable planning strategies, evidence
  composition, and repository/admission/generation/interceptor interfaces.
- **Application:** validated scope, admission, retrieval orchestration,
  optional synthesis, cancellation, and answer/citation validation.
- **Infrastructure:** parameterized SQLite analytics, an external-content FTS5
  index, bounded local admission, and separate restricted Copilot/HTTP strategies.
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
as FTS syntax. Conversational strategies prioritize requests, responses, files,
usage, overview, and chronology. Contextual expansion can include relevant scoped
records that were not literal keyword matches; `contextExpanded` discloses this.
No universal semantic-recall claim is made. Full text is already redacted at intake; retrieval does not bypass
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

### Codex demo answers

The browser's Codex answer process uses the selected model in an empty temporary
folder with ephemeral history, ignored user config/rules, shell and unified-exec
tools disabled, and apps, browser, computer, hooks and multi-agent features off.
Web search is disabled. It receives only the bounded question, conversation and
redacted retrieved evidence. Its JSON answer and citations are validated before
display; failures fall back to local evidence. This requires a recent Codex CLI
with `--ignore-user-config` support. Workspace tasks run separately with the
normal Codex workspace sandbox.

Exact tool-count questions use collector aggregates directly and skip embeddings
and model startup. Other questions retain Chroma/BM25/RRF and local reranking.
Changed log chunks are embedded in batches across spans; unchanged revisions
reuse their index. Local inference uses two CPU threads by default. These changes
retain the same embedding and reranking models; the answer-model override is
`MODEL_WORKLOG_DEMO_ANSWER_MODEL`.

Codex capture accepts the current cumulative `tokenUsage.total` counters and the
legacy usage format. Repeated cumulative updates do not double-count tokens.
Missing usage remains unknown. Whitespace fragments join their completed message;
adapter diagnostics stay separate. Long message fields start collapsed and can
be expanded. Old captures with missing token reports cannot be reconstructed.

Browser workspace tasks have a 250,000-token cumulative budget, including cached
input. Standalone CLI logger defaults are unchanged. Reported usage is retained
when a task fails or is interrupted, and budget stops identify the actual limit.
