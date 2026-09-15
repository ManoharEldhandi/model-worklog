# model-worklog-sdk

Local client SDK for recording observable AI activity in Model Logger. It communicates only with a loopback HTTP supervisor using its local credential.

```sh
npm install model-worklog-sdk
```

Start a local supervisor and trust the workspace before your application creates a session. Pass a short `title` to `startSession()` so the log and its JSON download use the task name. Then use `LocalSupervisorClient` to record visible user and assistant messages, high-level plans, provider-visible reasoning summaries, tools and results, files, commands, tests, and provider usage. `runTool()` records a correlated start/completion pair around a Promise-returning tool function. Complete the session when the run finishes. The SDK marks its events as `model-declared`; only a supervisor-owned relay can record direct vendor events as `observed-native`.

The same activity is available as a rich text log in the VS Code sidebar or with `model-worklog logs <session-id> --format pretty`, as structured JSON with `--format json` or `--format jsonl`, and as a portable JSON download with `model-worklog export <session-id> --output log.json`.

For an application terminal, desktop surface, or website backend, call
`session.followEvents(listener)`. It replays prior events and follows committed
redacted events every 100 ms by default until the session completes. The SDK also
exports `formatSessionEventText(event)` for a ready-to-use text block. Keep the
local supervisor credential in backend code; forward selected redacted events to
browser clients through your own authenticated application channel.

Never submit private chain-of-thought, credentials, or unobserved activity. See the [integration guide](https://github.com/ManoharEldhandi/model-worklog/blob/main/docs/integration.md) for a complete TypeScript example and provider usage mappings. Use is subject to the included license.
