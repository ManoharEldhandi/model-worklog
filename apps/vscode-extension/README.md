# Model Logger for VS Code

Model Logger is a local AI session logger. Install `model-worklog-<version>.vsix` using VS Code's **Extensions: Install from VSIX...** command, or run:

```sh
code --install-extension model-worklog-<version>.vsix
```

Open a trusted workspace and run **Model Logger: Enable Model Logger**. The extension starts or reconnects to the bundled local supervisor after that explicit action and shows activity in the Model Logger Activity Bar view.

Use **Log a Codex Task** to launch the installed, authenticated Codex CLI through the supervisor's App Server relay. Use **Log a Copilot CLI Task** to launch one prompted GitHub Copilot CLI task through its documented JSON event stream and OpenTelemetry usage export. Use **Start Interactive Copilot CLI** to open the normal interactive Copilot terminal experience with metadata-only telemetry enabled; final provider-reported token usage is saved when the session ends. Enable Model Logger also installs a dedicated personal Copilot CLI hook: restart Copilot CLI, then ordinary future Copilot CLI sessions in the trusted workspace log user prompts, tool activity/results, errors, and session lifecycle automatically. Copilot does not expose token counters to the automatic hook; use **Start Interactive Copilot CLI** or **Log a Copilot CLI Task** when a log needs provider-reported usage. Each log is named after its task. Logs are grouped as **Live Activity** and **Previous Activity** in the Model Logger sidebar. The newest log opens automatically when no log is selected, and selecting any log opens it directly in the Model Logger panel at the bottom of VS Code. It updates in place without taking editor focus and shows only sections with content, such as User Request, Agent Plan, Tools Used, Agent Response, and Tokens Used. Long entry bodies initially show a two-line preview; use **Show more** to expand a specific entry, which remains open through refreshes until you choose **Show less**. The complete redacted evidence remains available in **Download JSON**. **Tokens Used** is always the final section and says when no token usage was supplied. Directory inspections and file reads are labeled separately when the adapter can verify the target kind. Live logs offer **Stop Log**: it interrupts Logger-managed tasks, or stops recording an interactive Copilot CLI turn without closing the CLI. Finished logs provide **Delete Log**, which asks for confirmation before permanent removal.

The extension runs where the workspace extension host runs. In Remote-SSH,
containers, and Codespaces, the supervisor and relay run in the remote
workspace environment, not on the local desktop.

## Commands

- **Enable Model Logger** — starts or reconnects the loopback-only local supervisor, trusts the current workspace, and installs Model Logger's dedicated Copilot CLI personal hook.
- **Disable Model Logger** — disconnects this VS Code window and hides activity without stopping active agent work.
- **Log a Codex Task** — runs the installed, authenticated Codex CLI through the bundled relay.
- **Log a Copilot CLI Task** — runs the installed, authenticated Copilot CLI through its documented event and usage streams.
- **Start Interactive Copilot CLI** — opens normal interactive Copilot CLI with final metadata-only token logging.
- **Stop Live Log** — interrupts a Logger-managed task or stops recording an interactive Copilot CLI turn.
- **View Log** and **Download JSON** — available inside every log.
- **Delete Log** — available for finished logs and permanently removes local activity after confirmation.
- **Refresh Logs** — refreshes live and recent log groups.

The `model-worklog.supervisorUrl` setting must be a loopback HTTP address. Its default is `http://127.0.0.1:43199`. Model Logger never uploads workspace activity by default.

The personal hook is active only while at least one VS Code window has Model Logger enabled. It is removed after the final enabled window disables Logger. It does not capture VS Code Copilot Chat, which does not expose a compatible passive event stream.

For standalone scripts or application integration, install `model-worklog-sdk`; see the repository's [integration guide](https://github.com/ManoharEldhandi/model-worklog/blob/main/docs/integration.md). Use is governed by the repository [license](../../LICENSE).
