# Model Logger Security Model

Model Logger is a local-only logger, not a hosted logging service. It is
designed to reduce accidental exposure and network attack surface while
retaining evidence on the host where the workspace runs.

## Protections

- The supervisor, extension, and SDK accept only `127.0.0.1`, `localhost`, or
  `::1` over HTTP and normalize `localhost` to `127.0.0.1` where they launch a
  supervisor.
- Every non-health API call requires a per-installation, 256-bit local token.
  Token comparison is timing-safe.
- The store directory and token are hardened to owner-only POSIX permissions
  (`0700` and `0600`) and the token cannot be a symlink or other special
  file.
- An explicit trusted-workspace action is required before the supervisor runs
  a command or starts a Codex session.
- Commands are argument arrays, not shell strings. Git inspection disables
  repository hooks and external diff/text-conversion drivers.
- The supervisor owns every managed child process. A stop request records the
  cancellation, sends `SIGTERM`, and uses `SIGKILL` only after a bounded grace
  period when the process remains alive.
- A supervisor launched by the VS Code extension accepts authenticated,
  expiring client leases. It stops only after the last extension client releases
  its lease and no retained session is running; a CLI-managed supervisor never
  enables this shutdown mode.
- While Logger is enabled, the extension may install one Model Logger-owned
  Copilot CLI hook in the user's Copilot hooks directory. The hook invokes a
  bundled local bridge that posts only to the authenticated loopback supervisor,
  emits a neutral hook response, and is removed after the final extension lease
  is released. It never carries the supervisor token in the hook configuration.
- Evidence is redacted before storage, responses, search, or export. API
  responses are marked `no-store` and carry restrictive browser-oriented
  response headers.
- CLI evidence exports use owner-only POSIX permissions, even when replacing an
  existing file.
- The supervisor has bounded request bodies and conservative HTTP timeouts.

Because the service never listens on a network interface, ordinary network
man-in-the-middle attacks cannot reach it. The local HTTP transport is
intentional: TLS would not improve a connection that is restricted to the
same machine and protected by a local token.

## Operator Requirements

- Keep `MODEL_WORKLOG_HOME` on a local, user-owned disk. Do not place it in a
  shared directory or commit it to source control.
- Do not expose or port-forward the supervisor port. Do not change the VS Code
  `model-worklog.supervisorUrl` setting to anything other than loopback.
- Treat exported JSON evidence as potentially sensitive. Review it before
  sharing, even though automatic redaction runs.
- Install packages and VSIX files only from the authorized registry,
  Marketplace publisher, or GitHub Release. Verify the publisher and version.
- Keep Node.js, VS Code, Codex, and Model Logger updated. Report suspected
  vulnerabilities through [SECURITY.md](../SECURITY.md), not public issues.

## Important Limits

No application can protect evidence from malware, a debugger, or another
process already running as the same operating-system user. Such a process can
read files that you can read and can observe local process activity.

Redaction is defense in depth, not a promise that every secret format will be
recognized. Never intentionally send credentials, private reasoning, customer
data, or confidential source to a log.

The evidence-bundle SHA-256 manifest detects accidental or unsophisticated
modification. It is not a signature and does not prove authorship or defend
against a local attacker that can rewrite the bundle and its manifest.

External SDK integrations are retained as `model-declared` evidence. They
should not be treated as independently observed facts.
