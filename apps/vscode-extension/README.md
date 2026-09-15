# Model Worklog for VS Code

Model Worklog is a local AI session logger. Install the VSIX, open a trusted workspace, and run **Model Worklog: Enable Model Worklog**. The extension starts or reconnects to the bundled local supervisor after that explicit action and shows retained sessions in the Model Worklog Activity Bar view.

Use **Start Codex Session** to launch the installed, authenticated Codex CLI through the supervisor's App Server relay. Use **Start Logged Command** to retain redacted process output and a Git snapshot for any trusted command. Sessions can be followed live, reviewed later as clear text, stopped through Codex interruption, and exported as a redacted integrity-checked JSON bundle.

The extension runs where the workspace extension host runs. In Remote-SSH, containers, and Codespaces, the supervisor and relay run in the remote workspace environment, not on the local desktop.