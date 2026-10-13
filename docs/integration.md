# Integration

Instrument your application with the TypeScript SDK, an OTel exporter, or the
MCP wrapper; send traces to the same-host collector and inspect them in VS Code.
No CLI is required. Use Node.js **>=22.13** for the whole JavaScript project.
This guide targets upcoming **0.2.0**: new tracing packages are not yet published.
Use the checkout until the operator publishes them; older registry versions may
not expose these APIs.

## Operator Bootstrap

After 0.2.0 publication, install the operator and application packages:

```sh
npm install model-worklog-supervisor@0.2.0 model-worklog-sdk@0.2.0
```

This self-contained JavaScript example owns the collector lifecycle. Admin access
stays in the operator setup; the logger receives only a writer and queries use a
separate reader. Do not print or distribute the admin credential.

```js
import { startSupervisor, createTraceCredential } from 'model-worklog-supervisor';
import { createLocalModelLogger } from 'model-worklog-sdk';

const projectId = 'my-project';
const privacy = { mode: 'metadata' };
const supervisor = await startSupervisor({
  host: '127.0.0.1', port: 0, tracePrivacy: privacy,
});
try {
  const issue = role => createTraceCredential({
    url: supervisor.url, adminToken: supervisor.authToken,
    role, projects: [projectId], ttlSeconds: 86_400,
  });
  const writer = await issue('writer');
  const reader = await issue('reader');
  const logger = await createLocalModelLogger({
    projectId, serviceName: 'my-agent', endpoint: supervisor.url,
    token: writer.token, privacy,
    onDiagnostic: diagnostic => console.warn(diagnostic),
  });
  try {
    await logger.trace({
      name: 'lookup', kind: 'tool', input: { query: 'example' },
      serializeResult: result => result,
    }, () => ({ answer: 42 }));
  } finally {
    const status = await logger.shutdown();
    if (!status.success) console.warn('Incomplete telemetry', status);
  }
  const url = new URL('/v2/traces', supervisor.url);
  url.searchParams.set('projectId', projectId);
  const response = await fetch(url, {
    headers: { 'x-model-worklog-token': reader.token }, redirect: 'error',
  });
  if (!response.ok) throw new Error(`Trace query failed: ${response.status}`);
  console.log(await response.json());
} finally {
  await supervisor.close();
}
```

For a long-running application, keep the operator running and pass its actual
loopback URL and scoped writer through private application configuration. Only
one supervisor may own a data directory. SDK shutdown must precede collector
shutdown. Never port-forward the collector or give its credentials to browser code.

## Credentials And Endpoints

`createLocalModelLogger` prefers an explicit `token`; otherwise it reads the
private, nonsymlink `trace-writer-token` under `MODEL_WORKLOG_HOME` (default
`~/.model-worklog`). It reads neither `auth-token` nor `MODEL_WORKLOG_TOKEN` nor
`MODEL_WORKLOG_TRACE_TOKEN`. The factory does not start the collector.

An operator can provision the file with `startSupervisor({ traceProjectId })` or
VS Code **Configure SDK Logging**. The default lifetime is **24 hours**. Expired,
revoked, or wrongly scoped files are not silently replaced at startup: explicitly
renew/reprovision, then recreate/reconfigure clients. Wrong role/project is `403`,
not an invitation to fall back to admin; expired/invalid tokens are `401`.

Endpoint precedence: `endpoint`, `MODEL_WORKLOG_TRACE_ENDPOINT`,
`MODEL_WORKLOG_SUPERVISOR_URL`, then `http://127.0.0.1:43199/v2/traces/batch`.
The factory accepts a loopback HTTP origin or the exact batch path, without URL
credentials, query, or fragment; redirects are disabled.

## Privacy And TypeScript

The bootstrap deliberately uses metadata-only capture. Content needs **both**
SDK `privacy.mode: 'redacted-content'` and operator
`tracePrivacy.mode: 'redacted-content'`. Changing the shared `privacy` value above
configures both explicitly. Result/chunk content additionally needs
`serializeResult`/`serializeChunk`. The collector cannot restore content already
discarded by the SDK, spool, or upstream instrumentation.

Use `logger.trace` for operations, `logger.wrap` for functions, and `logger.stream`
for single-pass async iterators. The [SDK reference](../packages/adapter-sdk/README.md)
includes TypeScript, `ModelLoggerSpanExporter` for OTel JS/OpenInference/OpenLLMetry,
and `instrumentMcpClient` for MCP. None installs universal agent instrumentation.
Inspect `flush()`/`shutdown()` status: queues can drop snapshots and spooling is
not exactly-once delivery. Missing token usage remains unknown, not zero.

## Python Via OTLP

Use the [official HTTP/protobuf exporter](https://opentelemetry-python.readthedocs.io/en/latest/exporter/otlp/otlp.html),
not gRPC. In your Python environment install `opentelemetry-sdk` and
`opentelemetry-exporter-otlp-proto-http`. The operator must keep the collector
running and privately supply its loopback origin and a scoped writer. Here
`APP_TRACE_WRITER_TOKEN` is an application-defined variable, not SDK token discovery.

```python
import os
from opentelemetry.exporter.otlp.proto.http import Compression
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

provider = TracerProvider(resource=Resource.create({"service.name": "python-agent"}))
exporter = OTLPSpanExporter(
    endpoint=os.environ["MODEL_WORKLOG_SUPERVISOR_URL"].rstrip("/") + "/v1/traces",
    headers={
        "x-model-worklog-token": os.environ["APP_TRACE_WRITER_TOKEN"],
        "x-model-worklog-project": "my-project",
    },
    compression=Compression.NoCompression,
    timeout=5,
)
provider.add_span_processor(BatchSpanProcessor(
    exporter, max_queue_size=512, max_export_batch_size=100,
))
try:
    with provider.get_tracer("my-agent").start_as_current_span("lookup") as span:
        span.set_attribute("tool.name", "lookup")
    if not provider.force_flush(timeout_millis=5000):
        raise RuntimeError("Trace flush timed out")
finally:
    provider.shutdown()
```

`POST /v1/traces` accepts `application/x-protobuf` or `application/json`, up to
**100 final spans and 2 MiB** per request. No compression or gRPC is supported.
A count limit alone cannot enforce the byte limit: bound attributes/content and
reduce batches further when necessary. Configure upstream capture and collector
privacy separately; Python does not run the Model Logger JS redactor or spool.
Monitor exporter errors; an OTel flush completing does not prove delivery.

## VS Code And Compatibility

Enable Model Logger, use **Select Trace Project** for the same `projectId`, then
**Configure SDK Logging** with operator/admin access to provision the writer.
**Traces** and **Trace Details** show captured spans, usage, and capture limits;
readers can browse/export, while writer-only credentials cannot browse.
**Export Captured Trace JSON** exports captured data, not hidden reasoning or a
signed identity. Set `model-worklog.supervisorUrl` to the actual loopback origin.

Existing session SDKs, CLI commands, and agent launchers remain optional
compatibility paths, not prerequisites for tracing. VS Code documents agent
hooks, but a new VS Code Chat hook adapter is not implemented here. Hook coverage
depends on the selected harness, version, configuration, and policy. See the
[capability matrix](adapter-capability-matrix.md), [evidence model](evidence-model.md),
and [security model](security-model.md) before interpreting or sharing captures.
