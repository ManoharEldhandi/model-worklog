# Model Logger

**Private, SDK-first traces for agent workflows.**

Wrap your agents, model calls, tools, and retrieval steps with Model Logger.
Review nested spans, results, usage, errors, and capture gaps in VS Code or
through the local API. The collector stores redacted traces in SQLite and
accepts OpenTelemetry over HTTP, including protobuf exporters used by Python.

Metadata-only capture is the default. Content requires explicit opt-in. Hidden
reasoning and uninstrumented actions are not observable. The core logger is
released as [2.1.0](https://github.com/ManoharEldhandi/model-worklog/releases/tag/v2.1.0),
including the [npm SDK](https://www.npmjs.com/package/model-worklog-sdk).
The new SDK RAG layer is available from **`feat/local-log-rag`**; it is not yet
part of the published 2.1.0 packages.

## Install

### SDK And VS Code

Install [Model Logger from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=manohareldhandi.model-worklog), or run:

```sh
code --install-extension manohareldhandi.model-worklog
```

Use the matching VSIX from the [2.1.0 release](https://github.com/ManoharEldhandi/model-worklog/releases/tag/v2.1.0)
when you need the exact tracing build.
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

### Run Logger + RAG With One Command

From this checkout on **`feat/local-log-rag`**:

```sh
git branch --show-current
bash scripts/run-rag.sh
```

The launcher checks dependencies, installs missing Node/Python runtimes locally,
installs locked JavaScript and pinned Python packages, builds the SDK, and starts
Chroma plus CPU embedding/reranking models. It records sample logs, retrieves a
cited answer, and opens an **Ask logs** terminal prompt. No API key or extension
is needed. First use downloads model weights; later runs reuse the cache.

```sh
bash scripts/run-rag.sh --no-chat    # Record, answer and exit
bash scripts/run-rag.sh --check      # Full live integration + precision/recall + ANN checks
bash scripts/run-rag.sh --setup-only # Install dependencies and build
```

Use macOS or glibc Linux; on Windows, use WSL2. Bash, tar, and curl or wget must
be available. Installs stay in the checkout; model weights are cached under
`~/.cache/model-worklog/models`. No sudo or shell-profile changes are made.
Exit or Ctrl+C stops the services and removes the temporary demo index. Quality
reports and service logs are saved in `output/rag/`. See [setup details](docs/sdk-rag.md).

### Web Dashboard Demo

Run a local browser dashboard that asks GitHub Copilot to review an isolated
copy of the included Harbor Inventory sample workspace. It shows observable
Copilot file reads, tool activity, visible responses, and enclosing SDK spans as
they arrive. The dashboard starts an isolated loopback collector with temporary
scoped credentials, so the browser never receives a collector token.

```sh
npm run build
npm run demo:web
```

Open the printed `http://127.0.0.1:...` URL. To connect an OpenAI-compatible
chat-completions endpoint instead, configure its values only in the server
environment:

```sh
export MODEL_WORKLOG_DEMO_PROVIDER='openai-compatible'
export MODEL_WORKLOG_DEMO_OPENAI_URL='https://provider.example/v1/chat/completions'
export MODEL_WORKLOG_DEMO_OPENAI_MODEL='your-model-name'
export MODEL_WORKLOG_DEMO_OPENAI_API_KEY='your-provider-key'
npm run demo:web
```

The default provider is the locally installed Copilot CLI, which must already
be authenticated with `copilot login`. To run the dashboard without any model
account, select the built-in response explicitly:

```sh
export MODEL_WORKLOG_DEMO_PROVIDER='offline-demo'
npm run demo:web
```

The process deletes its temporary local trace store when it stops. The visible
timeline reports explicit SDK operations and output only; it does not claim to
show provider-hidden reasoning. When a run finishes, choose **Download JSON**
in the dashboard to export its visible timeline, response, and redacted trace
summary; the export never contains collector credentials.

## What It Captures

- Instrumented agent, model, tool, MCP, retrieval, embedding, memory, and workflow spans.
- Parent relationships, links, timing, state, optional redacted content, and reported usage.
- Capture limitations, redactions, truncation, missing parents, and explicit delivery failures.

Readable activity logs group consecutive file reads into one timestamped segment,
pair correlated tools with their results, and keep failures and capture gaps
visible. The dashboard, VS Code and CLI pretty logs share the same deterministic
projection. Structured activities retain source references for later search;
the original captured records remain the evidence. See the
[activity model](docs/evidence-model.md#readable-activity-projection).

## Ask Captured Logs

For application integration, use the **SDK RAG module**:

```ts
import { LogRag, ChromaLogVectorStore, OpenAiLogEmbedder } from 'model-worklog-sdk/rag';

const rag = new LogRag({
  store: new ChromaLogVectorStore({ url: 'http://127.0.0.1:18561', collection: 'my-agent-logs' }),
  embedder: new OpenAiLogEmbedder({
    endpoint: 'http://127.0.0.1:18562/v1/embeddings', model: 'BAAI/bge-small-en-v1.5',
    queryPrefix: 'query: ', documentPrefix: 'passage: ',
  }),
});
// Index existing spans, use LogRagTraceExporter, or import through CollectorLogSource.
const result = await rag.search({ projectId: 'default', question: 'Why did the refund fail?' });
```

The module combines **Chroma cosine HNSW, BM25 and RRF**, with optional local
reranking and cited answer generation. Applications can replace its embedder,
store, source, reranker or answer provider. No editor is required. See the
[SDK setup and integration guide](docs/sdk-rag.md) and
[retrieval-quality measurements](docs/rag-evaluation.md).

### Measured RAG Quality

The live quality gate passed **22 SDK checks** and ranked the relevant source
first for **all 32 curated test questions**:

| Measurement | Recorded result |
| --- | ---: |
| Source precision@1 | **100%** |
| Source recall@3 | **100%** |
| HNSW recall@10 versus exact cosine, 2,048 vectors / 50 queries | **99.4%** |

These are synthetic regression fixtures used during development, not a blind
production benchmark. The selected reranking profile measured 1.35 seconds p50
on a local CPU. [Results, methodology and reproducible commands](docs/rag-evaluation.md)
include BM25/vector/RRF comparisons and the [recorded JSON report](docs/rag-evaluation-results.json).

### Existing Collector Clients

Use **Ask logs** in the web demo, **Ask Captured Logs** in the VS Code Traces
view, or the CLI to query retained traces:

```sh
npm run cli -- ask "What tools were used?" --project default --format pretty
npm run cli -- ask "How many times was read_file used?" --project default
```

**Ask logs** is a conversation grounded in captured requests, replies, files,
tools, errors, timing, models, and reported usage. Ask for a summary, follow up
with **What did it answer?**, or investigate a failure. Copilot explains retrieved
evidence with inline citations; counts and source records are supporting details,
not the primary view. Tool totals still come from exact SQL, not a prompt sample.

The Copilot demo enables restricted, tool-disabled log answers; questions do not
rerun the workspace agent. Local evidence-only mode remains available without an
AI account. Choose **Record sample** for a repeatable 122-tool-call workload, or
capture a real workspace review. See the [conversation and API guide](docs/log-retrieval.md)
for provider consent, scope, legacy-session coverage, privacy, and limits.

## Privacy

- Private local storage, metadata-first capture, and redaction before buffering and storage.
- Expiring, revocable writer/reader credentials scoped to projects; admin-only management.
- Bounded queues and storage; retries do not duplicate accepted span revisions.
- No cloud logging account, automatic upload, global monkey-patching, or hidden-reasoning capture.
- Optional answer synthesis sends only bounded redacted evidence to an explicitly configured model after per-query opt-in.

Redaction is a safeguard, not a guarantee. Do not intentionally send
credentials or confidential data to a log.

## Learn more

- [Integration guide](docs/integration.md)
- [Product goal and architecture](docs/architecture.md)
- [SDK log RAG](docs/sdk-rag.md)
- [Evidence model](docs/evidence-model.md)
- [Security model](docs/security-model.md)
- [Release guide](docs/releasing.md)

## Contributing

Model Logger is open source under the [MIT License](LICENSE). Feedback, issues,
and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
