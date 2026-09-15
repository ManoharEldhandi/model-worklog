# Changelog

## Unreleased

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
