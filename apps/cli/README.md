# model-worklog

Command-line interface for local Model Logger sessions.

```sh
npm install -g model-worklog
model-worklog supervisor start
model-worklog workspace trust .
model-worklog sessions list
```

Use `model-worklog logs <session-id>` to review a session and `model-worklog export <session-id> --output session.json` for a redacted evidence bundle. Full documentation: [Model Logger](https://github.com/ManoharEldhandi/model-worklog). Licensed under MIT.

## Ask Captured Traces

```sh
model-worklog ask "What tools were used?" --project default --format pretty
model-worklog ask "How many times was read_file used?" --project default
model-worklog ask "What failed?" --project default --limit 5 --format json
model-worklog ask "Summarize this run" --project default --conversation ./chat.json
model-worklog ask "What failed?" --project default --conversation ./chat.json
```

Use an authorized project with retained SDK/OTLP traces. `--trace`, `--tool`,
`--since`, `--until`, and `--intent` narrow the query. Counts cover all matching
retained tool spans, not just returned evidence. Raw legacy sessions are not
implicitly imported. Reader/admin credentials use the existing private token
lookup; writer credentials cannot query.

Local answers are the default. `--synthesis model` explicitly permits sending
bounded redacted evidence to an operator-configured provider; failed synthesis
falls back locally. See the [retrieval guide](https://github.com/ManoharEldhandi/model-worklog/blob/main/docs/log-retrieval.md).

`--conversation` saves bounded redacted questions and answers in a private local
file for follow-ups. Reuse the same project, trace, tool, and time filters; a
changed scope requires a new file. No history is saved without this flag.
