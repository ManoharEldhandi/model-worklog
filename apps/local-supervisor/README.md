# model-worklog-supervisor

Same-host trace collector and local store for Model Logger. Requires Node.js
**>=22.13**, including built-in SQLite support. This reference targets upcoming
**0.2.0**; the new tracing API remains unpublished until the operator releases it.
Use locally built workspace packages meanwhile. No CLI setup is required.

## Programmatic Startup

After publication, install `model-worklog-supervisor@0.2.0`. In an operator process:

```js
import { startSupervisor, createTraceCredential } from 'model-worklog-supervisor';

const supervisor = await startSupervisor({
	host: '127.0.0.1', port: 0,
	tracePrivacy: { mode: 'metadata' },
});
const writer = await createTraceCredential({
	url: supervisor.url, adminToken: supervisor.authToken,
	role: 'writer', projects: ['my-project'], ttlSeconds: 86_400,
});
```

Pass only `supervisor.url` and `writer.token` to the instrumented application.
Issue a separate `reader` for queries; keep `supervisor.authToken` in operator
code. The [integration guide](../../docs/integration.md) shows both roles, SDK
shutdown, and `await supervisor.close()`. Never print credentials or port-forward.

## Options And Credentials

`startSupervisor` accepts `host` (`127.0.0.1` or `::1`), `port` (default `0`, an
available port), `dataDirectory`, `tracePrivacy`, `traceStorage`, and optional
`traceProjectId`. Use the returned URL rather than assuming port 43199. The data
directory defaults to `MODEL_WORKLOG_HOME` or `~/.model-worklog`; only one
supervisor may own it. `authToken` overrides are test-only, not deployment setup.

`traceProjectId` provisions a private `trace-writer-token` for one project, valid
for 24 hours by default. A valid matching file is reused; expired, revoked, or
mismatched files cause startup to fail. Renewal/removal/reprovisioning is an
explicit operator action, followed by client reconfiguration. An explicit
`createTraceCredential` call returns the token once without writing that file.

Writer and reader roles have explicit project scopes; only admin can issue or
revoke credentials, delete traces, or run retention. `401` means invalid/expired
authentication; `403` means forbidden role/project. Never retry with broader
credentials to bypass a forbidden scope. The SDK reads a writer file or explicit
token, not the admin file or token environment variables.

## HTTP API

All trace routes require `x-model-worklog-token`; `/health` is unauthenticated.
For OTLP, send `x-model-worklog-project` matching the writer's authorized project.

| Route | Role | Contract |
| --- | --- | --- |
| `GET /v2/identity` | Any authenticated role | Current role, projects, and scoped expiry. |
| `POST /v2/credentials` | Admin | `{ role, projects, ttlSeconds? }`; reader/writer only, default TTL 86,400 seconds. |
| `DELETE /v2/credentials/:id` | Admin | Revoke a scoped credential. |
| `POST /v2/traces/batch` | Writer/admin | Schema-version-1 JSON batch; acknowledgement has `accepted` and `duplicates`. |
| `POST /v1/traces` | Writer/admin | OTLP HTTP JSON or protobuf final spans. |
| `GET /v2/traces?projectId=...` | Reader/admin | Trace summaries with `nextCursor`. |
| `GET /v2/traces/:traceId?projectId=...` | Reader/admin | Stored spans with `nextCursor`. |
| `DELETE /v2/traces/:traceId?projectId=...` | Admin | Delete the selected project's trace. |
| `POST /v2/traces/retention` | Admin | `{ projectId, before?, limit? }`; requires `before` or a configured retention TTL. |

Ingest limits are **100 spans/snapshots and 2 MiB per request**. OTLP content types
are `application/json` and `application/x-protobuf`; compression and gRPC are not
supported. Bound exporter batches and content before sending. The collector
deduplicates revisions; conflicting current revisions return `409`.

Queries require `projectId`; cursors are opaque and scope-bound. List page size is
50 by default, at most 100; detail is 100 by default, at most 1,000. Use `limit`
and follow `nextCursor` until null. Pagination is not a point-in-time snapshot.

## Privacy And Storage

Metadata-only is the default. Content needs the application's capture opt-in and
operator `tracePrivacy: { mode: 'redacted-content' }`. Collector policy applies
again to SDK and OTLP intake before storage. No raw spool or hidden reasoning is
provided; retained data can still be sensitive.

Trace data lives in `trace-store/traces.sqlite` beneath the data directory.
`traceStorage` defaults to 100,000 stored spans, 128 MiB of accounted storage,
and 2,000 spans per trace (`maxStoredSpans`, `maxStoredBytes`, `maxSpansPerTrace`).
These are logical quotas, not a bound on SQLite/WAL/backup disk usage. Quota
failures require cleanup; they are not successful ingestion.

`retentionTtlSeconds` is opt-in. Cleanup is bounded and targets eligible terminal
trees with complete ancestry; it is not a background promise to delete every old
record. Follow retention's `hasMore` response for additional batches.

Use private local storage. POSIX permissions and file/link checks do not establish
Windows ACL parity or protection from a same-user attacker. See the
[security model](../../docs/security-model.md) and
[evidence model](../../docs/evidence-model.md).

Legacy session/agent-launch endpoints and the existing CLI remain compatibility
interfaces, not required tracing setup. Licensed under [MIT](LICENSE).
