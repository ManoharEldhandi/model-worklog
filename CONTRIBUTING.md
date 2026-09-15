# Contributing

Use Node.js 22 or later. Before opening a pull request, run:

```sh
npm ci
npm run release:check
```

For changes to the VS Code extension, also run `npm run extension:test`. Keep
retained evidence user-visible and avoid adding hidden reasoning or secrets to
event payloads.

The repository is source-available, not open source. You may use a fork and
the source only to prepare a contribution. Before submitting it, read and
agree to [CLA.md](CLA.md); opening the pull request confirms that agreement.

Use small, focused changes with tests for behavior changes. Do not commit
generated `dist/`, `out/`, `.vsix`, or local `.model-worklog/` data.
