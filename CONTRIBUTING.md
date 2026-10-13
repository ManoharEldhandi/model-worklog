# Contributing

Use **Node.js >=22.13** throughout the project, not 22.0; the collector depends
on built-in SQLite support. Work from the repository root.

## Development Gates

Before submitting behavior changes, run these serially in an isolated checkout:

```sh
cd "$(git rev-parse --show-toplevel)"
npm ci
npm run release:check
node examples/sdk-tracing-demo.mjs
```

`release:check` checks version alignment, builds/tests packages, installs/tests
the extension, checks npm pack contents, and packages a VSIX. On headless Linux,
run it as `xvfb-run -a npm run release:check`. The demo exercises the SDK, collector,
scoped reader, and retained trace contract. CI must qualify the exact minimum
Node 22.13.0 as well as the supported release runtime; floating Node 22 is not
minimum-version evidence. See [release gates](docs/releasing.md).

Do not run overlapping builds, prepack hooks, tests, or VSIX packaging in a
checkout under browser/editor validation: they rewrite shared generated output.
For docs-only work, check `git diff --check`, relative links, and documented APIs;
do not start builds or tests in another contributor's active validation checkout.

## Change Boundaries

- Prefer the tracing APIs for new integrations. Read public exports, types,
	controlling implementation, and nearby tests before documenting behavior.
- Keep SDK, collector, and VS Code contracts aligned. Preserve existing session
	and CLI compatibility; do not describe legacy commands as new tracing features.
- Test the changed behavior and its failure cases, including relevant project/role
	boundaries, privacy gates, missing usage, queue limits, and incomplete delivery.
- Keep metadata-only capture as the default. SDK content requires application
	and operator opt-in; never submit credentials or provider-hidden reasoning.
- Preserve evidence grades and capture limitations. Document harness-specific
	hook coverage and unqualified platforms without universal-capture, compliance,
	or benchmark claims.

Keep changes focused and documentation short, with examples using actual public
APIs. Do not commit generated `dist/`, `out/`, `test-dist/`, tarballs, VSIX files,
or local `.model-worklog/` data. Review exports before sharing them.

This repository is open source under the [MIT License](LICENSE). By submitting
a contribution, you agree that it may be distributed under the same license.
