# Model Logger Instructions

Start each task by reading `HANDOFF.md` and the relevant file under `docs/`.

## Architecture constraints

- VS Code is the primary interface. The local supervisor is the trust boundary and owns evidence storage, redaction, adapter lifecycle, and supervised run orchestration.
- Keep the extension usable as a client of the supervisor; do not place durable evidence, privacy, or process-control logic only in the extension host.
- Preserve evidence grades: `observed-native`, `observed-boundary`, `computed`, `model-declared`, `unknown`.
- Treat missing or unsupported evidence as `unknown`, not as a guessed fact.
- Model Logger is a logging product. Do not retain private chain-of-thought or present inferred activity as observed evidence.

## Implementation constraints

- Work in small vertical slices and run the narrowest available validation immediately after an edit.
- Do not claim a command or view is implemented unless it reaches a real backend behavior.
- Check VS Code workspace trust before starting local processes or executing repository-controlled code.
- Bind supervisor development endpoints to loopback or a Unix socket; never silently use an arbitrary remote URL.
- Redact sensitive data before durable storage, export, or upload. Upload is opt-in.
- Use native VS Code tree views for logs and session actions; add a webview only when a real log workflow needs richer presentation.
- Add an ADR for durable decisions about IPC/auth, supervisor runtime, sandboxing, evidence format, or hosted-data boundaries.

## Validation

For extension changes:

```sh
cd apps/vscode-extension
npm run compile
npm test
```

Do not reset, revert, or commit changes unless the user asks.
