# Releasing

Prepare **0.2.0** as the SDK-first tracing release. The implementation in this
checkout is not proof of publication: new tracing APIs remain unpublished until
an authorized operator publishes the npm packages and VSIX. Older registry
versions may lack them. This guide does not authorize a publish operation.

All shell blocks use the **repository root**, never an extension-directory shell.
Run validation and packaging serially in an isolated release checkout, away from
active browser/editor validation. Authentication and publication are operator-only.

## Prepare And Qualify

1. Coordinate the 0.2.0 bump across the root, schema, SDK, supervisor, CLI, and
   extension manifests, internal dependency ranges, and lockfiles. Do not leave
   `^0.1.x` dependencies pointing new tracing packages at legacy APIs.
2. Align Node requirements across the JavaScript project to **>=22.13.0**. The
   collector's SQLite dependency does not support an advertised 22.0 minimum.
3. Require green CI on **exact Node 22.13.0** and the supported release runtime.
   CI must run `release:check` and the SDK integration demo below, retain production
   dependency audits, and retain the packaged VSIX artifact.
4. Record the reviewed commit, runtimes/platforms tested, and VS Code trace-view
   validation. Windows ACL parity and other untested platform behavior remain
   unqualified; passing CI is not compliance certification or a benchmark.

The [version check](../scripts/check-release-versions.mjs) checks version equality,
not dependency ranges or Node engine consistency. Review those separately.
The [CI workflow](../.github/workflows/ci.yml) must enforce the exact-minimum gates;
a floating Node 22 job or split checks alone do not establish release readiness.
This documentation does not declare those gates complete.

On Linux CI, select Node 22.13.0 before running from the root:

```sh
cd "$(git rev-parse --show-toplevel)"
node --version
npm ci
xvfb-run -a npm run release:check
node examples/sdk-tracing-demo.mjs
```

On a desktop with a display, use `npm run release:check` without `xvfb-run`.
`release:check` builds/tests packages and the extension, checks packing, and
produces the VSIX. The [integration demo](../examples/sdk-tracing-demo.mjs) checks
SDK delivery, separate writer/reader access, retained spans, and evidence grades.
Resolve failures before packaging for publication; do not downgrade the gates.

## Stage Exact Artifacts

After the bump and gates pass, use an empty versioned staging directory. `npm pack`
runs build hooks, so do not run these commands concurrently. The VSIX copied here
must be the 0.2.0 artifact produced by the validated release check.

```sh
cd "$(git rev-parse --show-toplevel)"
release_dir="$PWD/artifacts/0.2.0"
mkdir -p "$release_dir"
npm pack --workspace model-worklog-schema --pack-destination "$release_dir"
npm pack --workspace model-worklog-sdk --pack-destination "$release_dir"
npm pack --workspace model-worklog-supervisor --pack-destination "$release_dir"
npm pack --workspace model-worklog --pack-destination "$release_dir"
cp apps/vscode-extension/model-worklog-0.2.0.vsix "$release_dir/"
```

Inspect all archive manifests, entry points, runtime dependencies, licenses, and
contents; exclude credentials, trace stores, and local spool files. Record artifact
SHA-256 hashes with the release record. Publish these exact reviewed bytes, not
fresh directories or a newly rebuilt VSIX. The CLI ships for existing compatibility;
this release does not add or advertise new CLI tracing features.

## Publish npm Packages

Only the authorized operator should run this block, with registry authorization
already configured privately. Publish tarballs in dependency order: **schema,
SDK, supervisor, CLI**. Stop on a failure and verify each dependency version is
available before publishing its dependent; do not continue with stale versions.

```sh
cd "$(git rev-parse --show-toplevel)"
release_dir="$PWD/artifacts/0.2.0"
npm publish "$release_dir/model-worklog-schema-0.2.0.tgz" --access public &&
npm view model-worklog-schema@0.2.0 version &&
npm publish "$release_dir/model-worklog-sdk-0.2.0.tgz" --access public &&
npm view model-worklog-sdk@0.2.0 version &&
npm publish "$release_dir/model-worklog-supervisor-0.2.0.tgz" --access public &&
npm view model-worklog-supervisor@0.2.0 version &&
npm publish "$release_dir/model-worklog-0.2.0.tgz" --access public
```

## Publish The VSIX

Provide `VSCE_PAT` through the operator's secret manager or protected CI environment.
Do not put a token in command arguments, source, logs, issues, or chats. Handle any
registry/Marketplace authentication prompts directly in the operator's terminal.
The installed `vsce` reads `VSCE_PAT`; `--packagePath` publishes the already-reviewed
VSIX without rebuilding it. Do not add a version argument or use a wildcard.

```sh
cd "$(git rev-parse --show-toplevel)"
release_dir="$PWD/artifacts/0.2.0"
: "${VSCE_PAT:?Provide VSCE_PAT through your secret manager}" &&
./apps/vscode-extension/node_modules/.bin/vsce publish \
  --packagePath "$release_dir/model-worklog-0.2.0.vsix"
```

## GitHub Release

Require an approved `v0.2.0` tag on the reviewed commit and operator GitHub release
authorization. Run from the root; do not first `cd apps/vscode-extension` and then
use root-relative paths. Attach the same tarballs and VSIX that were published.

```sh
cd "$(git rev-parse --show-toplevel)"
release_dir="$PWD/artifacts/0.2.0"
gh release create v0.2.0 \
  "$release_dir/model-worklog-schema-0.2.0.tgz" \
  "$release_dir/model-worklog-sdk-0.2.0.tgz" \
  "$release_dir/model-worklog-supervisor-0.2.0.tgz" \
  "$release_dir/model-worklog-0.2.0.tgz" \
  "$release_dir/model-worklog-0.2.0.vsix" \
  --verify-tag --title "0.2.0" --generate-notes
```

Verify registry versions, dependency resolution, fresh SDK/collector installation,
and installation of the exact Marketplace/VSIX build. Update publication wording
only after those artifacts are actually available. Release notes must retain
[capture limits](adapter-capability-matrix.md), [evidence limits](evidence-model.md),
and [security/platform limits](security-model.md); do not imply universal capture.
