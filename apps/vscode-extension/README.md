# Model Logger for VS Code

Model Logger is a local AI session logger. Install `model-worklog-<version>.vsix` using VS Code's **Extensions: Install from VSIX...** command, or run:

```sh
code --install-extension model-worklog-<version>.vsix
```

Open a trusted workspace and run **Model Logger: Enable Model Logger**. The extension starts or reconnects to the bundled local supervisor after that explicit action and shows retained sessions in the Model Logger Activity Bar view.

Use **Start Codex Session** to launch the installed, authenticated Codex CLI through the supervisor's App Server relay. Use **Start Logged Command** to retain redacted process output and a Git snapshot for any trusted command. Sessions can be followed live, reviewed later as clear text, stopped through Codex interruption, and exported as a redacted integrity-checked JSON bundle.

The extension runs where the workspace extension host runs. In Remote-SSH,
containers, and Codespaces, the supervisor and relay run in the remote
workspace environment, not on the local desktop.

## Commands

- **Enable Model Logger** — starts or reconnects the loopback-only local supervisor and trusts the current workspace.
- **Log a Codex Session** — runs the installed, authenticated Codex CLI through the bundled relay.
- **Log a Command** — records an explicit JSON command array without a shell.
- **Open Log**, **Refresh Logs**, **Stop Active Session**, and **Export Log** — review, follow, cancel, or export retained evidence.

The `model-worklog.supervisorUrl` setting must be a loopback HTTP address. Its default is `http://127.0.0.1:43199`. Model Logger never uploads workspace evidence by default.

For standalone scripts or application integration, install `model-worklog-sdk`; see the repository's [integration guide](https://github.com/ManoharEldhandi/model-worklog/blob/main/docs/integration.md). Use is governed by the repository [license](../../LICENSE).
