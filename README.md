# Model Logger

**Local-first activity logs for coding agents.**

Model Logger helps you review the visible work an AI agent does: messages,
plans, tool calls, commands, file changes, test results, errors, and
provider-reported token usage. Logs are stored locally as redacted JSON and
can be reviewed in VS Code or from the command line.

It does **not** record private chain-of-thought or guess at activity it cannot
observe.

## Install

### VS Code

Install [Model Logger from the VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=manohareldhandi.model-worklog), or run:

```sh
code --install-extension manohareldhandi.model-worklog
```

Then open a trusted workspace, run **Model Logger: Enable Model Logger**, and
open the **Model Logger** view from the Activity Bar.

Use **Log a Codex Task** or **Log a Copilot CLI Task** to start a supported
session. Codex or GitHub Copilot CLI must already be installed and authenticated
on the same host as the workspace.

### CLI

Requires Node.js 22 or later.

```sh
npm install -g model-worklog
model-worklog supervisor start
model-worklog workspace trust .
model-worklog sessions list
```

To review a session or export its redacted evidence:

```sh
model-worklog logs <session-id>
model-worklog export <session-id> --output model-worklog-session.json
model-worklog verify model-worklog-session.json
```

### SDK

Use the SDK when you want to connect another agent or application:

```sh
npm install model-worklog-sdk
```

The SDK sends structured events to the local supervisor. See the
[integration guide](docs/integration.md) for setup and examples.

## What it records

- Visible messages, plans, tools, commands, files, tests, errors, and summaries.
- Token usage only when the connected provider reports it.
- Evidence grades that distinguish observed, computed, agent-reported, and
  unavailable information.

## Privacy

- Logs stay on the machine where the workspace runs.
- Redaction happens before storage, viewing, or export.
- The local supervisor listens only on loopback and requires a local token.
- No telemetry, hosted logging service, or workspace upload is enabled by default.

Redaction is a safeguard, not a guarantee. Do not intentionally send
credentials or confidential data to a log.

## Learn more

- [Integration guide](docs/integration.md)
- [Evidence model](docs/evidence-model.md)
- [Security model](docs/security-model.md)
- [Release guide](docs/releasing.md)

## Contributing

Model Logger is open source under the [MIT License](LICENSE). Feedback, issues,
and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
