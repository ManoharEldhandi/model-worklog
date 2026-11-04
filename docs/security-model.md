# Security Model

Model Logger collects explicitly instrumented activity on the same host. It is
not a hosted service, a sandbox, or an independent observer of application truth.
Use Node.js >=22.13 for the repository and collector.

## Network Boundary

- `startSupervisor` binds only to `127.0.0.1` or `::1`. SDK HTTP clients also
  accept `localhost`; URLs must not contain credentials, queries, or fragments.
- Keep applications, collector, and reader on the same host. Do not port-forward
  the collector, expose it through a proxy, or bind it to a network interface.
- Trace requests require `x-model-worklog-token`. `/health` is unauthenticated
  and is not a credential or readiness check for a particular project.
- Trace routes validate the loopback Host and browser Origin/Fetch Metadata.
  Responses use `no-store` and restrictive browser headers. Do not give a browser
  the collector token; use a trusted backend for any application-facing UI.
- The SDK disables redirects. Local HTTP is intentional, not permission to send
  credentials to a remote collector.

## Credentials

| Role | Allowed operations |
| --- | --- |
| Writer | Submit SDK batches or OTLP spans for explicitly authorized projects. |
| Reader | List/read traces and query retained trace logs for explicitly authorized projects. |
| Admin | Issue/revoke credentials, delete traces, run retention, and read/write. |

Keep the installation `auth-token` and `RunningSupervisor.authToken` in the
operator process only. Use `createTraceCredential` to issue separate writer and
reader credentials; neither scoped role can mint credentials or use `*` scope.
Stored scoped credentials contain token digests, not the issued plaintext token.
Missing, expired, or revoked tokens return `401`; wrong role/project returns
`403`. A forbidden scope is not a reason to retry with the admin credential.

Scoped credentials default to **24 hours**. `startSupervisor({ traceProjectId })`
can provision a private `trace-writer-token` file for that one project. Startup
reuses a valid matching file but refuses an expired, revoked, or differently
scoped file. There is no automatic renewal: the operator must issue a replacement
or explicitly remove/reprovision that file, then reconfigure/recreate clients.
Replacing the file does not change a token already loaded into an SDK instance.

`createLocalModelLogger` uses an explicit `token` or the writer file under
`MODEL_WORKLOG_HOME` (default `~/.model-worklog`). It does not read `auth-token`,
`MODEL_WORKLOG_TOKEN`, or `MODEL_WORKLOG_TRACE_TOKEN`. Never log tokens, commit
them, place them in command arguments, or paste them into chats.

## Privacy Gates

Metadata-only capture is the default. For SDK content, **both** the application
logger's `privacy.mode` and the operator's `startSupervisor({ tracePrivacy })`
must use `redacted-content`. Result/chunk capture also requires an explicit
serializer. The collector applies its own policy to every intake path, including
OTLP; an application cannot opt the collector into content capture.

The SDK redacts before queueing or spooling; the collector redacts again before
storage and returns stored, redacted spans. The disk spool is not a raw-payload
archive. Configure its privacy policy consistently with the logger; a stricter
policy can discard content earlier. No provider-hidden reasoning is collected.

Known secret patterns and forbidden reasoning fields are removed or redacted;
attributes, strings, events, and payloads are bounded. Metadata names and
explicitly allowed attribute keys can still disclose sensitive information.
Redaction cannot identify all sensitive prose: keep capture off where needed,
use `excludedKeys`, and review exports before sharing.

Collector intake is bounded to 100 spans/snapshots and 2 MiB per request.
OTLP accepts HTTP JSON or protobuf, not compression or gRPC. Bounded SDK queues
can drop telemetry; neither a successful application call nor a local spool
guarantees complete or exactly-once evidence.

## Log Retrieval And Optional Synthesis

The SDK's [Chroma RAG module](sdk-rag.md) is opt-in and independent of editor UI.
It redacts and bounds chunks before embedding/indexing. Its project filters are
not authentication: the embedding application must authorize callers. Chroma is
a separate derived copy; wire deletion into application retention or run complete
scoped `sync(..., { prune: true })` after collector retention. A partial scan
cannot authorize pruning. Use a single writer and a separate collection for a
changed embedding model/version. Indexing and source storage are not one transaction.

`POST /v2/logs/query` inherits trace authentication, explicit project scoping,
loopback origin guards, and redaction. Writer credentials cannot query. Exact
aggregates and bounded FTS5 excerpts use retained spans only; legacy sessions are
not silently imported. Index maintenance shares the span transaction, including
revisions, rollback, deletion, and retention. Query admission is separate from
authentication and ingestion.

The standalone query API defaults to local evidence-only mode. Optional synthesis
requires an operator-configured provider and a model-enabled request. The Copilot
browser demo explicitly configures that provider and enables **Copilot answers**;
users can turn it off. The question, bounded recent conversation, redacted
authorized evidence, and exact aggregates are sent; a provider may retain that
data under its own policies.
Redaction is not a guarantee that prose is non-sensitive. Do not opt in for data
that must remain on the host. Configured endpoints require HTTPS or loopback HTTP
and cannot redirect credentials. API keys remain in the operator environment.

The Copilot answer subprocess has no available tools, denies shell/write/URL
permissions, disables built-in MCP/custom instructions and remote export, and
runs in an isolated empty working directory. This is a restricted provider
configuration, not an OS sandbox. The installed CLI and its local authentication
remain trusted. Copilot may retain requests in its own private session state;
the collector's no-history-storage behavior is not a provider retention promise.

Retrieved text and previous answers are untrusted data, never executed. Bounded
output and per-answer source-ID validation reduce generation risks but cannot
prove that a model's claims follow from the evidence. Generated interpretations
are labelled; timeout/provider/citation failures show the local evidence answer.
Tool aggregates never depend on generation, though an AI may explain them.
Questions/history are not stored by the query layer. Browser history is bounded,
memory-only, and cleared on scope changes; exports are explicit. Marked output
is sanitized with DOMPurify before rendering, with scripts, images, active HTML,
and unsafe links excluded. Review exports and editor buffers like other content.
See [retrieval limits](log-retrieval.md) before deployment.

## Storage And Threat Limits

Keep the data directory and spool on private, local, user-owned storage, outside
source control. Collector storage uses owner-only POSIX directories/files
(`0700`/`0600`), checks ownership and file identities, and rejects unsafe links.
The SDK writer-token reader requires a private regular file and rejects symlinks.
Spools need a dedicated single-writer directory. Private permissions are not
encryption; backups, exported files, and the rest of the host need protection too.

Windows ACL enforcement and equivalent cross-platform filesystem guarantees are
**not qualified** by these POSIX checks. Do not infer platform readiness from
TypeScript compilation or a successful run on another OS. Host administrators,
debuggers, and malicious processes running as the same OS user are outside the
threat model; local authentication does not isolate them.

SDK and OTLP spans are `model-declared`. Legacy direct relays can retain
`observed-native` events, but that grade does not authenticate the actor's
identity. A legacy session bundle's SHA-256 audit manifest is a consistency check,
not a signature, proof of authorship, or protection against rewriting the bundle.
Trace JSON exports are not signed audit bundles either.

Legacy agent launchers remain optional and require explicit workspace trust.
Hook coverage depends on the harness, version, configuration, and policy; it is
not universal agent or editor surveillance. No compliance certification or
performance benchmark is implied. Report vulnerabilities via
[SECURITY.md](../SECURITY.md). See [integration](integration.md) for setup and
[evidence](evidence-model.md) for interpretation limits.
