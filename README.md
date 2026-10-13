# Model Logger

**Private, SDK-first traces for agent workflows.**

Wrap your agents, model calls, tools, and retrieval steps with Model Logger.
Review nested spans, results, usage, errors, and capture gaps in VS Code or
through the local API. The collector stores redacted traces in SQLite and
accepts OpenTelemetry over HTTP, including protobuf exporters used by Python.

Metadata-only capture is the default. Content requires explicit opt-in. Hidden
reasoning and uninstrumented actions are not observable. This repository's new
tracing release must be published before these APIs are available from registries.

## Install

### SDK And VS Code

Install [Model Logger from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=manohareldhandi.model-worklog), or run:

```sh
code --install-extension manohareldhandi.model-worklog
```

Use the matching locally built VSIX until the tracing release is published.
Open a trusted workspace, run **Enable Model Logger**, then **Configure SDK
Logging** in the **Traces** view. Choose a project; setup provisions a scoped
writer credential without putting it in source code or the webview.

```sh
npm install model-worklog-sdk
```

```ts
import { createLocalModelLogger } from 'model-worklog-sdk';

const logger = await createLocalModelLogger({ projectId: 'default', serviceName: 'my-agent' });
const tracedAgent = logger.wrap({ name: 'agent.run', kind: 'agent' }, runAgent);
try {
  await tracedAgent(input);
} finally {
  const delivery = await logger.shutdown();
  if (!delivery.success) console.warn('Incomplete telemetry', delivery);
}
```

Use your configured project and application function. No CLI is required.
For embedded collectors, content opt-in, streams, MCP, and OpenTelemetry, see
[Integration](docs/integration.md) and the [SDK reference](packages/adapter-sdk/README.md).

### Run From Source

Requires Node.js 22.13 or later. A self-contained example uses an isolated
collector, actual file operation, scoped credentials, and no AI credits:

```sh
npm ci
npm run build
node examples/sdk-tracing-demo.mjs
```

Existing Codex/Copilot launchers and legacy CLI session commands remain
available. They are not required for the new tracing SDK.

## What It Captures

- Instrumented agent, model, tool, MCP, retrieval, embedding, memory, and workflow spans.
- Parent relationships, links, timing, state, optional redacted content, and reported usage.
- Capture limitations, redactions, truncation, missing parents, and explicit delivery failures.

## Privacy

- Private local storage, metadata-first capture, and redaction before buffering and storage.
- Expiring, revocable writer/reader credentials scoped to projects; admin-only management.
- Bounded queues and storage; retries do not duplicate accepted span revisions.
- No cloud logging account, upload, global monkey-patching, or hidden-reasoning capture.

Redaction is a safeguard, not a guarantee. Do not intentionally send
credentials or confidential data to a log.

## Learn more

- [Integration guide](docs/integration.md)
- [Product goal and architecture](docs/architecture.md)
- [Evidence model](docs/evidence-model.md)
- [Security model](docs/security-model.md)
- [Release guide](docs/releasing.md)

## Contributing

Model Logger is open source under the [MIT License](LICENSE). Feedback, issues,
and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
