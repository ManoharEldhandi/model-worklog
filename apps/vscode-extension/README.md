# Model Logger for VS Code

Model Logger is a local AI session logger. Install `model-worklog-<version>.vsix` using VS Code's **Extensions: Install from VSIX...** command, or run:

```sh
code --install-extension model-worklog-<version>.vsix
```

Open a trusted workspace and run **Model Logger: Enable Model Logger**. The extension starts or reconnects to the bundled local supervisor after that explicit action and shows activity in the Model Logger Activity Bar view.

Use **Log a Codex Task** to launch the installed, authenticated Codex CLI through the supervisor's App Server relay. Use **Log a Command** to retain redacted process output and a Git snapshot for any trusted command. Each log is named after its task or command. Logs are grouped as **Live Activity** and **Previous Activity** in the Model Logger sidebar. Expand a log and choose **View Log** to show one readable selected log in the Model Logger panel at the bottom of VS Code. It updates in place without taking editor focus and shows only sections with content, such as User Request, Agent Plan, Tools Used, Agent Response, and Tokens Used. **Download JSON** uses the task name as its default filename. Finished logs also provide **Delete Log**, which asks for confirmation before permanent removal.

The extension runs where the workspace extension host runs. In Remote-SSH,
containers, and Codespaces, the supervisor and relay run in the remote
workspace environment, not on the local desktop.

## Commands

- **Enable Model Logger** — starts or reconnects the loopback-only local supervisor and trusts the current workspace.
- **Disable Model Logger** — disconnects this VS Code window and hides activity without stopping active agent work.
- **Log a Codex Task** — runs the installed, authenticated Codex CLI through the bundled relay.
- **Log a Command** — records an explicit JSON command array without a shell.
- **View Log** and **Download JSON** — available inside every log.
- **Delete Log** — available for finished logs and permanently removes local activity after confirmation.
- **Refresh Logs** — refreshes live and recent log groups.

The `model-worklog.supervisorUrl` setting must be a loopback HTTP address. Its default is `http://127.0.0.1:43199`. Model Logger never uploads workspace activity by default.

For standalone scripts or application integration, install `model-worklog-sdk`; see the repository's [integration guide](https://github.com/ManoharEldhandi/model-worklog/blob/main/docs/integration.md). Use is governed by the repository [license](../../LICENSE).
