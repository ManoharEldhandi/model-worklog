# model-worklog-schema

Versioned TypeScript types and validators for Model Logger sessions, events, evidence grades, and supervisor health responses.

```sh
npm install model-worklog-schema
```

Use it when building an adapter, client, or reader that needs to validate Model Logger evidence.

## Readable Activities

```ts
import { buildSessionActivity, buildTraceActivity, formatActivityText } from 'model-worklog-schema';

const sessionActivity = buildSessionActivity(events);
const traceActivity = buildTraceActivity(storedSpans);
const lines = sessionActivity.flatMap(formatActivityText);
```

Supply canonical session events or validated stored spans. Session activities are
ordered by committed sequence; trace activities use the latest retained revision.
Consecutive reads group by path, correlated tools retain their inputs/results,
and failures and capture gaps stay explicit. Inputs are not mutated.

Version-1 activities retain timestamps, resources, named tools/MCP servers, status,
details, evidence grades and original source references for later indexing.
Keep the source records: the projection is not a new evidence source, and bounded
presentation details do not replace captured payloads. Additional redaction is
best effort. See the [activity and evidence model](../../docs/evidence-model.md).

Full documentation: [Model Logger](https://github.com/ManoharEldhandi/model-worklog). Licensed under MIT.
