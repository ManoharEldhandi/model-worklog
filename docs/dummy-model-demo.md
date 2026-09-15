# Dummy product-model integration

`examples/dummy-model-run.mjs` is a complete, local-only integration test for a product model. It creates a session through `model-worklog-sdk`, records an observable product-tool call, stores a visible response summary, normalizes provider usage, and completes the session.

It deliberately does not collect hidden reasoning. SDK events are shown as `model-declared`, which accurately states that the product adapter supplied the facts.

## Run and inspect it

In one terminal, start a supervisor whose evidence stays in this repository (the directory is gitignored):

```sh
export MODEL_WORKLOG_HOME="$PWD/.model-worklog"
export MODEL_WORKLOG_SUPERVISOR_PORT=43200
npm run build
npm run supervisor
```

In a second terminal with the same `MODEL_WORKLOG_HOME` value:

```sh
export MODEL_WORKLOG_SUPERVISOR_URL=http://127.0.0.1:43200
npm run cli -- workspace trust .
npm run demo:model
# Copy the sessionId printed by the script.
npm run cli -- logs <session-id> --format pretty
npm run cli -- watch <session-id> --once --format pretty
```

The `logs` output shows the per-event evidence grade and the provider-reported token total. The durable JSON evidence is local at `.model-worklog/`.

## Replace the dummy call

Keep the `LocalSupervisorClient` and `startSession` setup in the example. Replace `runDummyModel()` with your model call, then report only observable, user-permitted facts around it:

- `toolCalled` and `toolCompleted` for product tools;
- `commandStarted` and `commandCompleted` when your product launches a command;
- `fileRead` or `fileChanged` for files your product actually accesses;
- `summary` for a visible answer or readable outcome, never private chain-of-thought;
- `reportProviderUsage` once, using the final provider response.

If your product's provider is not OpenAI-compatible, pass a `TokenUsageMapping` to `reportProviderUsage`. See [Integration](integration.md) for the supported response shapes.
