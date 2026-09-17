import { randomUUID } from 'node:crypto';

import * as vscode from 'vscode';

import type { SessionEvent } from 'model-worklog-schema';

import { buildLogDetail, type LogDetailModel } from './logDetailPresentation';
import type { SupervisorSession } from './supervisorApi';

const DETAILS_CONTAINER_COMMAND = 'workbench.view.extension.model-worklog-details';

type WebviewMessage = { readonly type: 'render'; readonly model?: LogDetailModel };

export function logDetailsHtml(): string {
	const nonce = randomUUID();
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  :root { color: var(--vscode-editor-foreground); background: var(--vscode-panel-background); font-family: var(--vscode-font-family); }
  body { margin: 0; background: var(--vscode-panel-background); }
  header { position: sticky; top: 0; z-index: 1; padding: 12px 18px; border-bottom: 1px solid var(--vscode-panel-border); background: var(--vscode-panel-background); }
  h1 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: 0; }
  #meta { margin-top: 4px; color: var(--vscode-descriptionForeground); font-size: 12px; }
  main { padding: 0 18px 24px; }
  section { padding: 12px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  section:last-child { border-bottom: 0; }
  h2 { margin: 0 0 8px; color: var(--vscode-sideBarSectionHeader-foreground); font-size: 12px; font-weight: 600; letter-spacing: 0; text-transform: uppercase; }
  .entry { padding: 7px 0; border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent); }
  .entry:first-of-type { border-top: 0; }
  .label { font-size: 12px; font-weight: 600; }
  pre { margin: 4px 0 0; color: var(--vscode-editor-foreground); white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--vscode-editor-font-family); font-size: 12px; line-height: 1.45; }
  pre.preview { max-height: 2.9em; overflow: hidden; }
  .expand { margin: 4px 0 0; padding: 0; border: 0; color: var(--vscode-textLink-foreground); background: transparent; cursor: pointer; font: inherit; font-size: 12px; }
  .expand:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
  .empty { color: var(--vscode-descriptionForeground); font-size: 12px; }
  #blank { margin: 24px 0; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body>
<header><h1 id="title">Model Logger</h1><div id="meta">Choose View Log from a saved log.</div></header>
<main id="content"><p id="blank">No log selected.</p></main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const title = document.getElementById('title');
  const meta = document.getElementById('meta');
  const content = document.getElementById('content');
  const persisted = vscode.getState() || {};
  let selectedSessionId = persisted.sessionId;
  const expandedEntries = new Set(Array.isArray(persisted.expandedEntries) ? persisted.expandedEntries : []);
  function persistExpandedEntries() {
    vscode.setState({ sessionId: selectedSessionId, expandedEntries: [...expandedEntries] });
  }
  function needsExpansion(value) {
    return value.length > 240 || value.split(/\\r?\\n/).length > 2;
  }
  function entry(value, entryId) {
    const element = document.createElement('div');
    element.className = 'entry' + (value.content ? '' : ' empty');
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = value.label;
    element.append(label);
    if (value.content) {
      const body = document.createElement('pre');
      body.textContent = value.content;
      const expandable = needsExpansion(value.content);
      if (expandable && !expandedEntries.has(entryId)) body.className = 'preview';
      element.append(body);
      if (expandable) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'expand';
        const expanded = expandedEntries.has(entryId);
        toggle.textContent = expanded ? 'Show less' : 'Show more';
        toggle.setAttribute('aria-expanded', String(expanded));
        toggle.addEventListener('click', () => {
          const isExpanded = body.classList.toggle('preview') === false;
          if (isExpanded) expandedEntries.add(entryId); else expandedEntries.delete(entryId);
          toggle.textContent = isExpanded ? 'Show less' : 'Show more';
          toggle.setAttribute('aria-expanded', String(isExpanded));
          persistExpandedEntries();
        });
        element.append(toggle);
      }
    }
    return element;
  }
  function render(model) {
    content.replaceChildren();
    if (!model) {
      selectedSessionId = undefined;
      expandedEntries.clear();
      persistExpandedEntries();
      title.textContent = 'Model Logger';
      meta.textContent = 'Choose View Log from a saved log.';
      const blank = document.createElement('p');
      blank.id = 'blank';
      blank.textContent = 'No log selected.';
      content.append(blank);
      return;
    }
    if (selectedSessionId !== model.sessionId) {
      selectedSessionId = model.sessionId;
      expandedEntries.clear();
      persistExpandedEntries();
    }
    title.textContent = model.title;
    meta.textContent = (model.status === 'live' ? 'Live' : model.status.charAt(0).toUpperCase() + model.status.slice(1)) + ' | ' + model.updateCount + (model.updateCount === 1 ? ' update' : ' updates') + ' | ' + model.sessionId;
    for (const section of model.sections) {
      const area = document.createElement('section');
      const heading = document.createElement('h2');
      heading.textContent = section.title;
      area.append(heading);
      section.entries.forEach((item, index) => area.append(entry(item, model.sessionId + ':' + section.title + ':' + index + ':' + item.label)));
      content.append(area);
    }
  }
  window.addEventListener('message', (message) => {
    if (message.data && message.data.type === 'render') render(message.data.model);
  });
  vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/** Renders the selected log in the extension's bottom panel without editor focus changes. */
export class LogDetailsView implements vscode.WebviewViewProvider {
	private view: vscode.WebviewView | undefined;
	private model: LogDetailModel | undefined;
	private selectedEvents: readonly SessionEvent[] = [];
  private ready = false;

	get selectedSessionId(): string | undefined {
		return this.model?.sessionId;
	}

  async show(): Promise<void> {
    await this.reveal();
  }

	resolveWebviewView(view: vscode.WebviewView): void {
		this.view = view;
    this.ready = false;
		view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.onDidReceiveMessage((message: unknown) => {
      if (typeof message !== 'object' || message === null || (message as { type?: unknown }).type !== 'ready') {
        return;
      }
      this.ready = true;
      void this.post();
    });
    view.webview.html = logDetailsHtml();
	}

	async select(session: SupervisorSession): Promise<void> {
		this.selectedEvents = [];
		this.model = buildLogDetail(session, this.selectedEvents);
		await this.reveal();
		await this.post();
	}

	append(session: SupervisorSession, events: readonly SessionEvent[]): void {
		if (this.model?.sessionId !== session.sessionId || events.length === 0) {
			return;
		}
		const bySequence = new Map(this.selectedEvents.map((event) => [event.sequence, event]));
		for (const event of events) {
			bySequence.set(event.sequence, event);
		}
		this.selectedEvents = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
    const latestSequence = this.selectedEvents.at(-1)?.sequence ?? 0;
    this.model = buildLogDetail({ ...session, eventCount: Math.max(session.eventCount, latestSequence) }, this.selectedEvents);
		void this.post();
	}

	updateSession(session: SupervisorSession): void {
		if (this.model?.sessionId !== session.sessionId) {
			return;
		}
		this.model = buildLogDetail(session, this.selectedEvents);
		void this.post();
	}

	clear(sessionId?: string): void {
		if (sessionId !== undefined && this.model?.sessionId !== sessionId) {
			return;
		}
		this.model = undefined;
		this.selectedEvents = [];
		void this.post();
	}

	private async reveal(): Promise<void> {
		await vscode.commands.executeCommand(DETAILS_CONTAINER_COMMAND);
		this.view?.show(true);
		await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
	}

	private post(): Promise<boolean> {
    if (this.view === undefined || !this.ready) {
      return Promise.resolve(false);
    }
    return Promise.resolve(this.view.webview.postMessage({ type: 'render', ...(this.model === undefined ? {} : { model: this.model }) } satisfies WebviewMessage));
	}
}