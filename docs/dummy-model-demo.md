# Example Agent Integration

`examples/dummy-model-run.mjs` uses the same `model-worklog-sdk` and local supervisor path as a real agent integration. It creates a session, records the visible request, a high-level plan, a readable reasoning summary, tool calls and results, file review, file change, command/test activity, provider usage, and a final visible response summary.

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
npm run cli -- logs <session-id> --format json
npm run cli -- export <session-id> --output ./model-worklog-session.json
```

The pretty log is a detailed text view for people. The JSON command emits the saved session and updates for scripts. The JSON download includes the session, all redacted updates, workspace snapshots, cost report, and an integrity manifest. Logs stay local in `.model-worklog/`.

## View It In VS Code

1. Install the current Model Logger VSIX, open this repository as a trusted workspace, and run **Model Logger: Enable Model Logger**.
2. In a terminal at the repository root, run `npm run demo:live`.
3. The running session appears under **Live Activity** in the Model Logger sidebar within one second.
4. Expand **Review Model Logger README**, select **View Log**, and watch one readable log appear in the **Model Logger** panel at the bottom of VS Code. It updates about every 2.5 seconds with only the sections that have content: User Request, Agent Plan, Tools Used, Files, Commands, Agent Response, and Tokens Used. The demo performs a real `README.md` read and `node --version` command, then reports a clearly simulated provider token response before it completes after about 20 seconds.
5. Once complete, the session moves to **Previous Activity**. Select **Download JSON** to save its complete redacted JSON log, or **Delete Log** to remove the test session.

The extension and terminal process must use the same workspace environment and default local store. In a Remote-SSH or container workspace, run `npm run demo:live` in that remote environment.

## Replace the dummy call

Keep the `LocalSupervisorClient` and `startSession` setup in the example. Replace `runDummyModel()` with your model call, then report only observable, user-permitted facts around it:

- `toolCalled` and `toolCompleted` for product tools;
- `commandStarted` and `commandCompleted` when your product launches a command;
- `fileRead` or `fileChanged` for files your product actually accesses;
- `plan` and `reasoningSummary` for visible high-level intent and provider-readable rationale, never private chain-of-thought;
- `summary` for a visible answer or readable outcome;
- `reportProviderUsage` once, using the final provider response.

If your product's provider is not OpenAI-compatible, pass a `TokenUsageMapping` to `reportProviderUsage`. See [Integration](integration.md) for the supported response shapes.
