# Releasing Model Logger

This repository publishes four npm packages and one VS Code extension. Keep
their versions aligned; `npm run release:check` now enforces that requirement.
The marketplace display name is **Model Logger**. The package and extension
identifier remain `model-worklog` for compatibility.

## Preconditions

1. Confirm that the root and all package `LICENSE` files contain the MIT License
   and that all package manifests declare `"license": "MIT"`.
2. Confirm that the GitHub repository is public and that its README, issue
   templates, and release notes accurately describe the open-source project.
3. Ensure the npm names `model-worklog-schema`, `model-worklog-sdk`,
   `model-worklog-supervisor`, and `model-worklog` are available to your
   npm account or organization.
4. Create or confirm the VS Code Marketplace publisher named
   `manohareldhandi`. If the account uses another publisher ID, change
   `apps/vscode-extension/package.json` before publishing.
5. Enable npm two-factor authentication and configure npm Trusted Publishing
   for this GitHub repository before using provenance. Use a granular,
   short-lived token only if Trusted Publishing is unavailable.
6. Create a VS Code Marketplace publishing token, store it only as a secret,
   and never commit it. Do not print npm, Marketplace, or GitHub tokens in CI
   logs.

## Release checklist

```sh
npm ci
npm run release:check
npm run extension:test
npm audit --omit=dev
npm --prefix apps/vscode-extension audit --omit=dev
```

Review release notes and set the same new version in the root manifest, all
four npm package manifests, and `apps/vscode-extension/package.json`. Run
`npm run release:versions` before publishing.

Publish from a clean, reviewed Git commit in dependency order:

```sh
npm publish --workspace model-worklog-schema --access public --provenance
npm publish --workspace model-worklog-sdk --access public --provenance
npm publish --workspace model-worklog-supervisor --access public --provenance
npm publish --workspace model-worklog --access public --provenance
```

Then publish the extension after its VSIX has passed validation:

```sh
cd apps/vscode-extension
npx vsce publish -p "$VSCE_PAT"
```

Create a Git tag such as `v0.1.0`, push it, and attach `apps/vscode-extension/model-worklog-<version>.vsix` to the GitHub release for direct offline installation.

Immediately after publishing, install the exact npm package into a new
temporary project, install the VSIX into a test VS Code profile, and confirm
the Marketplace display name is **Model Logger** and the extension ID is
`manohareldhandi.model-worklog`. If you had an older local extension that
showed another product name, uninstall that extension or install this VSIX
over it and reload VS Code.

## Rollback

Do not unpublish a released npm version after consumers may have resolved it. Publish a patched version instead. Unpublish or replace a Marketplace extension only when necessary to address a security issue; document the affected version in the release notes.
