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
| Reader | List and read traces for explicitly authorized projects. |
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
