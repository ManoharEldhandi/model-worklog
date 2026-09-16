# Contributing

Use Node.js 22 or later. Before opening a pull request, run:

```sh
npm ci
npm run release:check
```

For changes to the VS Code extension, also run `npm run extension:test`. Keep
retained evidence user-visible and avoid adding hidden reasoning or secrets to
event payloads.

This repository is open source under the [MIT License](LICENSE). By submitting
a contribution, you agree that it may be distributed under the same license.

Use small, focused changes with tests for behavior changes. Do not commit
generated `dist/`, `out/`, `.vsix`, or local `.model-worklog/` data.
