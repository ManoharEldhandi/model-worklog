# SDK log RAG progress

The advanced retrieval layer belongs to `model-worklog-sdk/rag`. Applications can
integrate and extend it without the VS Code extension. Existing collector,
browser and CLI queries remain compatible; no new editor chat UI is required.

| Task | Result |
| --- | --- |
| Capture and provenance | Bounded redacted chunks, metadata-only support, source identities/revisions, explicit shortening and indexed coverage. |
| Index | Chroma cosine HNSW, model fingerprint checks, idempotent revision updates, scoped deletion and complete-source retention sync. |
| Retrieval | BM25 identifiers, semantic embeddings, weighted RRF, optional local reranking, failure-state signals, abstention and disclosed fallback. |
| SDK integration | Direct trace exporter, optional collector delegate, scoped collector import, replaceable providers and source-linked answers. |
| Compatibility | Collector follow-up/evidence fixes, bounded reader APIs, CLI history, browser flow tests and live Copilot qualification. |
| Quality | Unit regressions, real capture-to-answer/import/delete integration, source-level retrieval metrics and a separate exact-cosine ANN oracle. |
| Delivery | Reproducible local harness, CI quality job and setup/API/benchmark documentation. |

Behavior tests drove the fixes: missing query APIs failed compilation, incorrect
follow-up/output retrieval failed assertions, exporter revision acknowledgements
failed before correction, and overlong redacted labels failed persistence bounds.
Model/ranking experiments are recorded in the [evaluation](rag-evaluation.md).

Run `npm run test:rag:live` after the [local setup](sdk-rag.md). It writes detailed
cases, metrics and service logs to `output/rag/` and cleans up temporary services
and storage. The full repository release gate remains `npm run release:check`.

Local qualification on macOS ARM with Node 22.13.0 passed the complete release
gate: 331 package/dashboard tests passed (two capability-gated skips), four
Chromium flows, 72 Electron extension tests, the tracing demo, npm pack checks
and VSIX packaging. The separate live RAG gate passed all 22 tests plus semantic
and ANN evaluation. Root and extension production dependency audits reported
zero vulnerabilities. The optional installed Copilot smoke also passed exact
count and failure follow-up questions with real provider-generated citations.
