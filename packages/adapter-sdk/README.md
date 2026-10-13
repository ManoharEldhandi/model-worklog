# model-worklog-sdk

Node.js >=22.13 SDK for explicit local tracing. Targets upcoming **0.2.0**.
New tracing APIs remain unpublished until the operator releases the packages.
Use the checkout meanwhile; after publication install `model-worklog-sdk@0.2.0`.

## Local Setup

No CLI is required. Use the [operator bootstrap](../../docs/integration.md) to start
the collector and issue separate writer/reader credentials. A v1-only supervisor
cannot ingest traces. The example assumes a provisioned writer-token file and
configured collector endpoint.

```ts
import { createLocalModelLogger } from 'model-worklog-sdk';

const logger = await createLocalModelLogger({
	projectId: 'my-project', serviceName: 'my-agent',
	onDiagnostic: diagnostic => console.warn(diagnostic),
});
const lookup = logger.wrap({ name: 'lookup', kind: 'tool' },
	async (query: string) => ({ matches: [query] }));
try {
	await logger.trace({ name: 'agent.run', kind: 'agent' },
		() => lookup('example'));
	const source = (async function* () { yield 'first'; yield 'second'; })();
	for await (const chunk of logger.stream({ name: 'response', kind: 'model' }, source)) {
		process.stdout.write(chunk);
	}
} finally {
	const status = await logger.shutdown();
	if (!status.success) console.warn('Incomplete telemetry', status);
}
```

`createLocalModelLogger` reads an explicit `token`, otherwise the private regular
file `~/.model-worklog/trace-writer-token` (or under `MODEL_WORKLOG_HOME`). It rejects
symlinks and group/other file access. It never reads `auth-token`,
`MODEL_WORKLOG_TOKEN`, or `MODEL_WORKLOG_TRACE_TOKEN`. Default writer lifetime is
24 hours; operator renewal and client reconfiguration are explicit, not automatic.

Endpoint precedence is `endpoint`, `MODEL_WORKLOG_TRACE_ENDPOINT`, then
`MODEL_WORKLOG_SUPERVISOR_URL`; the fallback is
`http://127.0.0.1:43199/v2/traces/batch`. Pass a loopback HTTP origin or that exact
path, without credentials/query/fragment. Redirects and remote hosts are rejected; do not port-forward.

## Span API

- `trace(options, operation)` preserves the returned value or original error.
  `wrap(options, fn)` preserves arguments and `this`, returning an async function.
- `stream(options, asyncIterableOrFactory)` is lazy and single-pass; chunks pass
	through unchanged. The factory receives the span; closing early records
	`interrupted`. `onChunk(chunk, span)` can extract usage. Close/exhaust iterators;
	hook/serializer failures are diagnostics, not application errors.
- Nested spans inherit context via logger-local `AsyncLocalStorage`. Use
  `parent: null` for a root, `parent: context` for a remote parent, or `links` for
  causal links. `currentContext()`, `span.context`, `parseTraceparent`, and
  `formatTraceparent` expose W3C IDs; no baggage, injection, or sampling is installed.
- Handles support `setAttribute`, `setAttributes`, `addEvent`, `setUsage`,
  `recordProviderUsage(provider, response, mapping?)`, `captureInput`, and
  `captureOutput`. Missing usage stays unknown, not zero. Do not sum cumulative
  streaming usage chunks or infer opaque billing totals.

## Content And Privacy

Metadata-only is the default. Content requires **both** SDK
`privacy: { mode: 'redacted-content' }` and the operator's
`startSupervisor({ tracePrivacy: { mode: 'redacted-content' } })`.
`input`/capture methods are explicit; returned values require `serializeResult`,
and stream chunks require `serializeChunk`. Neither serializer runs by default.

Known metadata keys and `allowedAttributeKeys` survive the metadata filter;
`excludedKeys` can remove sensitive fields. Keep names low-cardinality and free
of content. Secrets and forbidden reasoning fields are redacted before queueing
or spooling and again by the collector. Redaction is best effort; no hidden
reasoning or universal agent visibility is provided. See the
[security model](../../docs/security-model.md).

## OpenTelemetry JavaScript

```ts
import { BasicTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { createLocalModelLogger, ModelLoggerSpanExporter } from 'model-worklog-sdk';

const otelLogger = await createLocalModelLogger({ projectId: 'my-project', serviceName: 'my-agent' });
const provider = new BasicTracerProvider({
	spanProcessors: [new BatchSpanProcessor(new ModelLoggerSpanExporter(otelLogger))],
});
provider.getTracer('my-agent').startSpan('agent.run').end();
await provider.forceFlush();
await provider.shutdown();
```

Use the exporter in your OTel/OpenInference/OpenLLMetry provider; it installs no
global provider or instrumentation. Completed spans reconstruct starts, not live
starts; logger project/service identity wins and resource contents are not copied.
`forceFlush()`/`shutdown()` reject incomplete delivery; shutdown owns the logger.
Python uses [official OTLP HTTP export](../../docs/integration.md).

## MCP

For a configured MCP `client` and a live `logger`:

```ts
import { instrumentMcpClient } from 'model-worklog-sdk';
const tracedClient = instrumentMcpClient(client, logger, { serverName: 'local-tools' });
const result = await tracedClient.callTool({ name: 'lookup', arguments: { query: 'example' } });
```

The opt-in proxy traces `callTool`, `listTools`, `readResource`, `listResources`,
`getPrompt`, and `listPrompts`, preserving client types, receivers, results, and
errors. Other methods remain untraced. Request/result content uses the same two
privacy gates; the wrapper supplies the result serializer. No global patching.

## Delivery And Bounds

| Option | Default |
| --- | --- |
| `maxQueueSize`, `maxActiveSpans` | 1,024 snapshots and 1,024 active spans |
| `maxBatchSize`, `maxBatchBytes` | 32 snapshots, 1 MiB including envelope |
| `flushIntervalMs` | 1,000 ms; zero disables the timer, not size-triggered flush |
| `limits` | 64 KiB/span, 16 KiB/attribute set, 64 events |
| `maxRetries`, `exportTimeoutMs` | 2 retries, 5,000 ms |

Local collector requests must stay within **100 snapshots and 2 MiB**. Full queues
drop new snapshots, possibly final ones. Network/HTTP 408, 429, and 5xx failures
are retryable; bad acknowledgements and authorization failures are not. Exhausted
delivery pauses automatic retries with work pending; explicit `flush()` retries.

`flush()` drains its starting snapshot of work; `shutdown()` stops capture,
interrupts active spans, flushes, and closes the exporter without cancelling app
operations. Both return `TraceFlushResult`: inspect `success`, `pending`,
`unpersisted`, `durablePending`, `dropped`, `failed`, and `lossRisk`. Counts also
include `accepted`, `duplicates`, `retries`, and `diagnosticFailures`.
`failed` counts delivery-cycle snapshots, not unique spans; any cumulative drop
keeps `success` false. `durablePending: null` means inventory failed. Configuration
errors throw at setup; telemetry failures use bounded metadata-only diagnostics.

Memory-only queues are not crash durable. For optional disk buffering, pass
`spool: await DiskTraceSpool.open({ directory, privacy, limits })`; import
`DiskTraceSpool` from this package and use a private, canonical, local single-writer
directory. Defaults are 10,000 files/64 MiB (`maxFiles`, `maxBytes`). Only redacted
snapshots are spooled; writes and replay use the stricter policy.
The disk spool's `prepare()` policy is applied before the first upload, so a
cleanup failure replays the same canonical snapshot. Custom spools may provide
the same deterministic `prepare(span)` hook; `append` and `read` must preserve
prepared snapshots. Keep policies/limits consistent while records are pending;
changing them can conflict with an already accepted revision. Drain or explicitly
quarantine pending records before changing policy rather than silently discarding them.
App calls do not await durable commits. Quota/disk failures leave work pending;
crashes before append can lose it. Ack-before-deletion crashes replay duplicates.
The collector deduplicates revisions; this is **not exactly-once delivery**.

For a custom transport, `createModelLogger({ projectId, serviceName, exporter })`
accepts `TraceExporter.export(batch, signal?)` returning `TraceBatchAck` and an
optional `shutdown()`. Honor cancellation and frozen batches; acknowledgements
must cover every snapshot. Wire schemas are exported by `model-worklog-schema`.

## Compatibility

`LocalSupervisorClient`, `WorklogSession`, and vendor session adapters support
existing integrations; these optional legacy paths are not needed for tracing.
SDK/OTLP evidence is `model-declared`; see the
[capability matrix](../../docs/adapter-capability-matrix.md) for limits. Licensed under [MIT](LICENSE).
