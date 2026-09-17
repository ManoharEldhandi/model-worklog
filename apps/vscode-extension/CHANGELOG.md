# Changelog

## Unreleased

- Fix the interactive Copilot CLI launcher under VS Code's Electron extension host and run it as the terminal process. Clarify that VS Code does not expose existing Copilot Chat activity to other extensions.
- Add **Start Interactive Copilot CLI**, which opens the normal Copilot terminal UI with metadata-only telemetry and records final provider-reported token usage when the session exits.
- Explain in **Tokens Used** when an automatic Copilot CLI hook log cannot include usage counters, and direct users to **Log a Copilot CLI Task** for provider-reported usage.
- Preserve expanded detail entries during live redraws, always show the final **Tokens Used** section, and distinguish verified directory inspections from file reads.
- Fix detail-panel rendering after adding collapsed log entries. The generated webview script now preserves the regular-expression escapes required for its ready/render handshake.
- Open the newest agent log automatically when no log is selected, and open a selected sidebar log directly in the detail panel.
- Require the Copilot hook turn-completion capability before reusing a running supervisor, so an old runtime cannot leave finished Copilot turns live.
- Complete automatic Copilot CLI hook logs when the agent finishes a turn, add **Stop Log** for live activity, and collapse long detail entries behind a per-entry expand control without changing exported JSON.
- Install and remove a dedicated Copilot CLI personal hook with the VS Code Logger lifecycle. It logs future normal Copilot CLI session prompts, tools/results, errors, and lifecycle without blocking tools or storing raw reasoning.
- Add a direct GitHub Copilot CLI relay using its documented JSON event stream and OpenTelemetry usage export. It records visible messages, tool activity, results, errors, and reported token usage without retaining raw reasoning.
- Remove automatic workspace-change and terminal-shell sessions. The sidebar now shows only adapter-backed agent activity and hides legacy observer logs.
- Add expiring VS Code client leases so an extension-launched supervisor starts
	on enable, survives while another VS Code window remains enabled, and stops
	after the final window releases it and live evidence completes.
- Keep CLI-managed supervisors running when the VS Code extension disables.
- Give every VS Code terminal shell execution a separate live log with its own
	command, bounded output, and terminal state, including concurrent terminals.
- Name logs from their task, command, supplied SDK title, or first user request, and use that name as the default JSON download filename.
- Render only populated selected-log sections and show final visible assistant output under **Agent Response**.
- Add a sectioned bottom Model Logger panel for one selected live or historical log, including live token totals and a final Tokens Used section.
- Add confirmed durable deletion for completed logs.
- Keep live and historical activity inside the Model Logger sidebar. Selected logs update in place and no longer open an editor tab.
- Add **Disable Model Logger** for disconnecting the current VS Code window without interrupting active work.
- Simplify each log to **View Log** and **Download JSON**, and use plain-language labels for activity, privacy, and token availability.
- Added a complete VSIX build, type-check, lint, and extension-host test workflow.
- Bundle the local supervisor and its SDK dependencies for offline VSIX installation.
- Normalize implicit loopback supervisor URLs and prevent inherited non-loopback bind configuration.
- Redesigned the visible extension experience as **Model Logger**: a focused Logs view with logging, review, and export commands only.

## 0.1.0

- Initial Model Logger release.
- Bundled loopback-only local supervisor with explicit workspace enablement.
- Live and historical readable AI session logs.
- Codex App Server relay with cancellation, duration/token limits, redaction, and durable outcomes.
- Generic logged-command sessions and redacted evidence export.
