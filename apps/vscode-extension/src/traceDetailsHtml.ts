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
<p id="status" role="status">No trace selected.</p><ul id="warnings"></ul>
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
      (parent ? parent.children : content).append(node.element);
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