# Changelog

## Unreleased

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
