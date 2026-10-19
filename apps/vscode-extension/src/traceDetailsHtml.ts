import { randomUUID } from 'node:crypto';

export function traceDetailsHtml(): string {
	const nonce = randomUUID();
	return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  :root { color: var(--vscode-editor-foreground); background: var(--vscode-panel-background); font: var(--vscode-font-size)/1.5 var(--vscode-font-family); letter-spacing: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 12px 16px 24px; }
  h1 { font-size: 14px; font-weight: 600; margin: 0; overflow-wrap: anywhere; }
  h2 { font-size: 12px; font-weight: 600; margin: 16px 0 4px; }
  .activity-time { color: var(--vscode-descriptionForeground); font: 11px var(--vscode-editor-font-family); }
  .activity[data-status="failed"] > summary { color: var(--vscode-errorForeground); }
  .activity[data-status="unknown"] > summary { color: var(--vscode-editorWarning-foreground); }
  .activity-fields { margin: 0 0 12px 14px; }
  .capture-info { color: var(--vscode-descriptionForeground); font-size: 12px; }
  #meta, #status { color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; margin: 4px 0; }
  #warnings { padding: 8px 0 12px 18px; margin: 0; border-bottom: 1px solid var(--vscode-panel-border); overflow-wrap: anywhere; }
  details { min-width: 0; border-bottom: 1px solid var(--vscode-panel-border); }
  summary { padding: 8px 2px; cursor: pointer; overflow-wrap: anywhere; }
  summary:hover { background: var(--vscode-list-hoverBackground); }
  summary:focus-visible, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .span-meta { display: block; color: var(--vscode-descriptionForeground); padding-left: 14px; font-size: 12px; }
  .warning { color: var(--vscode-editorWarning-foreground); overflow-wrap: anywhere; }
  .children { margin-left: 12px; padding-left: 8px; border-left: 1px solid var(--vscode-panel-border); }
  dl { margin: 0 0 12px 14px; }
  dt { color: var(--vscode-descriptionForeground); font-size: 12px; margin-top: 10px; }
  dd { margin: 0; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font: 12px/1.5 var(--vscode-editor-font-family); }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; padding: 5px 10px; margin-top: 12px; cursor: pointer; }
  button:disabled { opacity: .55; cursor: default; }
  [hidden] { display: none !important; }
</style></head><body>
<header><h1 id="title">Trace Details</h1><div id="meta"></div></header>
<p id="status" role="status">No trace selected.</p><details class="capture-info"><summary>Capture information</summary><ul id="warnings"></ul></details>
<main id="content" aria-label="Captured spans"></main>
<button id="more" type="button" hidden>Load More Spans</button>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let selection = saved.selection;
  const expanded = new Set(Array.isArray(saved.expanded) ? saved.expanded.filter(value => typeof value === 'string') : []);
  const content = document.getElementById('content');
  const more = document.getElementById('more');
  function persist() { vscode.setState({ selection, expanded: [...expanded].slice(0, 1000) }); }
  function text(tag, value, className) {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  }
  function render(model) {
    const scroll = document.documentElement.scrollTop;
    const focused = document.activeElement?.closest('details')?.dataset.spanId;
    if (selection !== model.key) { selection = model.key; expanded.clear(); persist(); }
    document.getElementById('title').textContent = model.title;
    document.getElementById('meta').textContent = model.meta;
    document.getElementById('status').textContent = model.notice;
    const warnings = document.getElementById('warnings');
    warnings.replaceChildren(...model.warnings.map(value => text('li', value)));
    warnings.hidden = model.warnings.length === 0;
    content.replaceChildren();
    content.setAttribute('aria-busy', String(model.busy));
    const activities = document.createElement('section');
    if (model.activity.length) activities.append(text('h2', 'Activity / UTC'));
    for (const activity of model.activity) {
      const item = document.createElement('details');
      item.className = 'activity';
      item.dataset.status = activity.status;
      const activityKey = 'activity:' + activity.id;
      item.open = expanded.has(activityKey);
      const heading = document.createElement('summary');
      heading.append(text('span', activity.startedAt.slice(11, 23) + 'Z  ', 'activity-time'), text('span', activity.title), text('span', activity.status, 'span-meta'));
      item.append(heading);
      const fields = document.createElement('div');
      fields.className = 'activity-fields';
      let populated = false;
      function populateActivity() {
        if (populated || !item.open) return;
        populated = true;
        if (activity.resources.length) fields.append(text('pre', activity.resources.map(resource => resource.path + (resource.count > 1 ? ' (' + resource.count + ' reads)' : '')).join('\\n')));
        if (activity.tools.length) fields.append(text('pre', activity.tools.map(tool => (tool.server ? tool.server + ' / ' : '') + tool.name).join('\\n')));
        for (const field of activity.details) fields.append(text('h2', field.label), text('pre', field.value));
        for (const warning of activity.warnings) fields.append(text('p', warning, 'warning'));
      }
      populateActivity();
      item.append(fields);
      item.addEventListener('toggle', () => {
        if (!item.isConnected) return;
        if (item.open) expanded.add(activityKey); else expanded.delete(activityKey);
        populateActivity(); persist();
      });
      activities.append(item);
    }
    content.append(activities);
    const records = document.createElement('details');
    records.open = expanded.has('span-records');
    records.append(text('summary', 'Span records / ' + model.spans.length));
    records.addEventListener('toggle', () => {
      if (!records.isConnected) return;
      if (records.open) expanded.add('span-records'); else expanded.delete('span-records');
      persist();
    });
    content.append(records);
    const nodes = new Map();
    for (const span of model.spans) {
      const element = document.createElement('details');
      element.dataset.spanId = span.id;
      element.open = expanded.has(span.id);
      const summary = document.createElement('summary');
      summary.append(text('span', span.name), text('span', span.summary, 'span-meta'));
      element.append(summary);
      if (span.warning) element.append(text('p', span.warning, 'warning'));
      const fields = document.createElement('dl');
      const children = document.createElement('div');
      children.className = 'children';
      element.append(fields, children);
      let populated = false;
      function populate() {
        if (populated || !element.open) return;
        populated = true;
        for (const field of span.fields) {
          const value = document.createElement('dd');
          value.append(text('pre', field.value));
          fields.append(text('dt', field.label), value);
        }
      }
      populate();
      element.addEventListener('toggle', () => {
        if (!element.isConnected) return;
        if (element.open) expanded.add(span.id); else expanded.delete(span.id);
        populate(); persist();
      });
      nodes.set(span.id, { element, children, summary, parentId: span.parentId });
    }
    for (const span of model.spans) {
      const node = nodes.get(span.id);
      let ancestor = nodes.get(span.parentId);
      let depth = 0;
      while (ancestor && depth <= 16) { depth += 1; ancestor = nodes.get(ancestor.parentId); }
      const parent = depth <= 16 ? nodes.get(span.parentId) : undefined;
      if (depth > 16) node.element.append(text('p', 'Deep hierarchy shown at top level; parent IDs retained.', 'warning'));
      (parent ? parent.children : records).append(node.element);
    }
    more.hidden = !model.more;
    more.disabled = model.busy;
    if (focused) nodes.get(focused)?.summary.focus({ preventScroll: true });
    document.documentElement.scrollTop = scroll;
  }
  more.addEventListener('click', () => vscode.postMessage({ type: 'more', key: selection }));
  window.addEventListener('message', event => {
    if (event.data?.type === 'render' && event.data.model) render(event.data.model);
  });
  vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}