# Model Logger for VS Code

Inspect instrumented application traces in **Model Logger > Traces**. The bundled supervisor stores retained spans locally in SQLite. Existing CLI session logs remain in **Logs**.

## SDK Quickstart

1. Open a trusted workspace and run **Model Logger: Enable Model Logger**.
2. In **Traces**, run **Configure SDK Logging** as an admin and choose a project ID. Change the view's project with **Select Trace Project** or `model-worklog.trace.projectId` (default: `default`).
3. Install `model-worklog-sdk` in your application and instrument its operations:

```ts
import { createLocalModelLogger } from 'model-worklog-sdk';

const logger = await createLocalModelLogger({
	projectId: 'default',
	serviceName: 'my-app',
});

try {
	await logger.trace({ name: 'example', kind: 'workflow' }, async () => {
		await logger.trace({ name: 'work', kind: 'custom' }, async () => {});
	});
} finally {
	await logger.shutdown();
}
```

Use your chosen project ID. **Model Logger SDK** output provides a matching, secret-free example. Setup writes a 24-hour, single-project writer credential to `trace-writer-token` in `MODEL_WORKLOG_HOME` (default `~/.model-worklog`), with mode `0600`. The SDK reads it directly. Tokens never go to the clipboard, settings, examples, or webviews. Replacement requires confirmation; valid other-project credentials, symlinks, hardlinks, public files, and changed targets are refused. Failed writes trigger revocation; failed revocation offers a retry. Restart SDK applications after replacement.

The application and supervisor must share the same environment and private home. For a non-default `model-worklog.supervisorUrl`, set the application's `MODEL_WORKLOG_SUPERVISOR_URL` to the same loopback origin. Remote workspaces run the supervisor remotely.

## Inspect And Export

Select a trace for nested spans, revisions, timing, attributes, events, links, evidence grade, and capture reports. Missing parents and cycles remain visible. Absent token totals and usage categories are **not reported**, never invented zeros or sums.

Refresh manually or keep either trace view visible for five-second polling. Requests are serialized and cancelled on project change, disable, or disposal. Load more traces or spans as needed; refresh retains loaded pages up to the ten-page view limit.

Readers and admins can export JSON. Export validates every returned page, rejects repeated cursors, and stops at 100 pages, 10,000 spans, 16 MiB of collected data, or 60 seconds. Failure does not save a partial export. Exports include capture-scope, missing-parent, and gap warnings, not connection credentials. Pagination is not a point-in-time snapshot. Admin-only deletion confirms both project and trace IDs; the backend reauthorizes every request.

## Privacy And Coverage

Supported agent hooks and instrumented applications only; coverage depends on integration. Enabling does not observe arbitrary chat or instrument applications automatically. Trace evidence is `model-declared`, not independent proof of execution. Provider-hidden reasoning is not collected. Redaction, truncation, drops, running spans, and uninstrumented work can leave gaps. Review exports before sharing.

The supervisor defaults to metadata-only capture. There is **no content opt-in toggle**: the current supervisor entry point does not map trace privacy environment settings. Content capture requires trusted startup wiring of `tracePrivacy` into `startSupervisor` plus SDK opt-in. An invented environment flag will not enable it. Capture reports show the policy actually applied.

## Optional CLI Logs

**Log a Codex Task**, **Log a Copilot CLI Task**, and **Start Interactive Copilot CLI** retain their existing launchers and session UI, including live updates, stop recording, JSON download, and confirmed deletion. Enable retains the existing Copilot CLI personal-hook setup; restart Copilot CLI for future hooked sessions. This is separate from SDK tracing and does not implement additional VS Code chat hooks.

**Disable Model Logger** disconnects this window without stopping active agent work; the legacy personal hook is removed after the last enabled window disconnects. Trace failures are reported separately without discarding saved session data. The trace UI defaults to the existing local operator `auth-token`, with roles fetched from `/v2/identity`; the trace client also supports injected reader credentials. Scoped trace tokens cannot access legacy session endpoints.
