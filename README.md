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
The SDK RAG layer is available from the **`main` source checkout**; it is not yet
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

From this checkout on **`main`**:

```sh
git branch --show-current
bash scripts/run-rag.sh
```

The launcher installs missing dependencies, builds the SDK, starts Chroma and
local embedding/reranking models, then opens the dashboard. Codex uses
`gpt-5.6-terra` with low reasoning effort for workspace tasks and the smaller
`gpt-5.6-luna` for log answers, using your existing CLI login (`codex login`).

The launcher creates `.env` from `.env.example` on first use. Edit it to set the
default project folder and model. `.env` is ignored by Git; keep personal paths and credentials there. The default is the
included Harbor Inventory sample, run in a temporary copy. To work on another
project, enter its folder in the dashboard and click **Use folder**. Those tasks
work on the selected folder directly. Workspace configuration shows only the folder name; captured activity can
include file paths.

1. In workspace chat, ask **Read the inventory and pricing code, run npm test,
   and explain what fails.**
2. Ask **Fix the negative quantity bug and rerun the tests.**
3. Open **Ask logs** and ask **Which test failed and why?** or **What changed?**
   Use **All retained traces** to compare tasks, or **Latest capture** for one run.

Log questions search captured activity through SDK RAG and return cited answers;
they do not rerun the workspace task. Switching folders starts a fresh log
session. Model calls use your Codex account; retrieval runs locally.

```sh
bash scripts/run-rag.sh --no-open    # Start the website and print its URL
bash scripts/run-rag.sh --check      # Browser, integration, precision/recall and ANN checks
bash scripts/run-rag.sh --setup-only # Install dependencies and build
```

Use macOS or glibc Linux; on Windows, use WSL2. Bash, tar, and curl or wget must
be available. Installs stay in the checkout; model weights are cached under
`~/.cache/model-worklog/models`. No sudo or shell-profile changes are made.
Ctrl+C in the terminal stops the services and removes the temporary demo index. Quality
reports and service logs are saved in `output/rag/`. See [setup details](docs/sdk-rag.md).

### Web Dashboard Demo

The dashboard pairs a workspace agent with its captured activity and a log
conversation. Run `npm run demo:web` for the same setup as the launcher above.
Use `MODEL_WORKLOG_DEMO_MODEL` and `MODEL_WORKLOG_DEMO_ANSWER_MODEL` in `.env`
to select account-supported models for workspace tasks and log answers. `MODEL_WORKLOG_DEMO_PROVIDER=copilot` selects an authenticated
Copilot CLI instead (reviews are read-only). `offline-demo` enables an explicitly
labelled scripted example without a model account.

An OpenAI-compatible chat endpoint can be configured with server-only
`MODEL_WORKLOG_DEMO_PROVIDER=openai-compatible`, `MODEL_WORKLOG_DEMO_OPENAI_URL`,
`MODEL_WORKLOG_DEMO_OPENAI_MODEL`, and `MODEL_WORKLOG_DEMO_OPENAI_API_KEY`.
That provider answers chat requests; it does not run a workspace agent.

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

The SDK retrieval evaluation ranked the relevant source first for
**all 32 curated test questions**:

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
with **What did it answer?**, or investigate a failure. The configured model explains retrieved
evidence with inline citations; counts and source records are supporting details,
not the primary view. Tool totals still come from exact SQL, not a prompt sample.

Log answers run separately with workspace tools disabled. In offline mode,
**Load offline example** records a scripted inventory workload for source
inspection. See the [conversation and API guide](docs/log-retrieval.md) for
scope, privacy and limits.

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
