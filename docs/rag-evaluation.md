# Log RAG evaluation

These are reproducible **curated regression results**, not a claim of perfect
retrieval on arbitrary production logs. The fixtures were used while improving
the implementation; the alternate-phrased test set is not an independent blind
benchmark. Add representative application logs and relevance labels before
choosing production thresholds.

The [recorded result snapshot](rag-evaluation-results.json) contains metrics,
latencies, runtime and index configuration for this report.

## Source relevance

Measured on 2026-11-04 with Node 22, Chroma 1.5.9, CPU ONNX embeddings
`BAAI/bge-small-en-v1.5` (384 dimensions), and the optional
`ms-marco-MiniLM-L-12-v2` reranker.

The corpus has 40 synthetic spans: 32 incident sources and eight successful
operations as hard negatives. Twelve development questions and 32 test questions
cover paraphrases, exact paths/tool names, failures, redaction and confusing
success/failure records. A foreign-project record checks isolation. Three
additional absent/control questions check unrelated topics and unavailable secrets.

| Pipeline, 32 test questions | Precision@1 | Recall@3 | MRR@10 | nDCG@5 |
| --- | ---: | ---: | ---: | ---: |
| BM25 | 87.50% | 96.88% | 0.9167 | 0.9301 |
| Embeddings + HNSW | 93.75% | 100% | 0.9688 | 0.9769 |
| Weighted RRF | 90.63% | 96.88% | 0.9375 | 0.9457 |
| RRF + selected reranking profile | 100% | 100% | 1.0000 | 1.0000 |

The selected profile also passed all 12 development questions at rank one.
On the recorded macOS ARM CPU run, its test-query latency was 1.35 seconds p50
and 1.58 seconds p95, versus 40/46 milliseconds for vector retrieval. Reranking
trades local CPU time for better source ordering on this corpus.
RRF alone was weaker than vectors here. The selected profile blends reranker
relevance with cosine similarity, uses retained failure states for failure
questions, and preserves a strong-semantic-match recall floor. A larger BGE
embedding model, another reranker and stricter rejection thresholds did not
improve this corpus; stricter rejection lost relevant evidence.

Metrics deduplicate chunk hits by source span. Each labelled question has one
relevant source, so maximum precision@3 is 1/3 and precision@5 is 1/5. The report
includes these values and recall at each cutoff rather than calling all top-five
results relevant. Weather and football questions return no evidence. A request
for a missing secret may retrieve redaction-related records; retrieval cannot
recover the secret. Scores and thresholds are model/corpus dependent.

## Approximate neighbour recall

A separate test compares Chroma HNSW top ten with brute-force exact cosine top
ten for 50 fresh queries over 2,048 seeded normalized 384-dimensional vectors.
With cosine, `max_neighbors=32`, `ef_construction=200`, `ef_search=128`, the latest
recorded run achieved **99.4% mean recall@10** (lowest query 90%). Other local
runs ranged from 99.0% to 99.4%; approximate construction can vary. Increasing search depth to 256
did not improve the earlier run. This checks index accuracy, not semantic relevance.

## Reproduce

Install the Python environment in the [SDK guide](sdk-rag.md), then run:

```sh
npm run test:rag:live
```

`bash scripts/run-rag.sh --check` also installs dependencies and checks the
browser flow against real local retrieval services. Answer-provider calls in
repeatable tests use controlled responses; live Copilot qualification is separate.

The command starts isolated loopback services and checks real SDK capture →
Chroma → local embeddings/reranking → cited answer, collector reader import,
writer denial, source deletion and index pruning. Reports are
`output/rag/evaluation.json` and `output/rag/ann.json`; CI uploads them with logs.
They include per-question rankings, p50/p95 timings and actual HNSW configuration.
Latency is machine dependent; this small corpus does not establish throughput or
large-corpus performance.

CI gates the selected semantic profile at precision@1 ≥95%, recall@3 ≥99%, and
mean ANN recall@10 ≥95%. Unit tests cover ranking math, redaction, revisions,
scope checks, provider validation, cancellation, fallback and retention safety.
The fixtures and metric implementation live in
[examples/rag/evaluation](../examples/rag/evaluation/fixtures.mjs).
