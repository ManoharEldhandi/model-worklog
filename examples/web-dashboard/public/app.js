const form = document.querySelector('#chat-form');
const input = document.querySelector('#message');
const sendButton = document.querySelector('#send-button');
const messages = document.querySelector('#messages');
const timeline = document.querySelector('#timeline');
const runState = document.querySelector('#run-state');
const traceCount = document.querySelector('#trace-count');
const downloadLink = document.querySelector('#download-link');
const providerMode = document.querySelector('#provider-mode');
const connectionStatus = document.querySelector('#connection-status');
const workspaceContext = document.querySelector('#workspace-context');
const search = document.querySelector('#activity-search');
const filter = document.querySelector('#activity-filter');
const followLog = document.querySelector('#follow-log');
const activityCount = document.querySelector('#activity-count');
const captureSummary = document.querySelector('#capture-summary');
const runDate = document.querySelector('#run-date');
const queryPanel = document.querySelector('#query-panel');
const queryForm = document.querySelector('#query-form');
const questionInput = document.querySelector('#question');
const queryScope = document.querySelector('#query-scope');
const queryTool = document.querySelector('#query-tool');
const queryIntent = document.querySelector('#query-intent');
const queryResult = document.querySelector('#query-result');
const queryStatus = document.querySelector('#query-status');
const queryError = document.querySelector('#query-error');
const askButton = document.querySelector('#ask-button');
const sampleButton = document.querySelector('#sample-button');
const queryExport = document.querySelector('#query-export');

let activeRun;
let pollTimer;
let currentRun;
let selectedView = 'activity';
let latestAnswer;
let queryRequestId = 0;
let pendingSampleQuery = false;
const expanded = new Set();
const rows = new Map();
const VIEW_LIMIT = 500;

function nearBottom(container) {
	return container.scrollHeight - container.scrollTop - container.clientHeight < 32;
}

function element(tagName, className, text) {
	const node = document.createElement(tagName);
	if (className !== undefined) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

function addMessage(role, text) {
	const follow = nearBottom(messages);
	messages.querySelector('.empty-state')?.remove();
	const message = element('article', `message ${role}`);
	message.append(element('p', 'message-label', role === 'user' ? 'You' : 'Assistant'));
	message.append(element('p', 'message-content', text));
	messages.append(message);
	if (follow) {
		messages.scrollTop = messages.scrollHeight;
	}
}

function setRunning(running) {
	sendButton.disabled = running;
	sampleButton.disabled = running;
	input.disabled = running;
	if (running) {
		setDownload({ downloadReady: false });
	}
	if (!running && selectedView !== 'query') {
		input.focus();
	}
}

function formatTimestamp(timestamp) {
	return timestamp.slice(11, 23);
}

function preview(entry) {
	if (entry.resources.length > 0) {
		const paths = entry.resources.slice(0, 3).map((resource) => resource.path).join('  |  ');
		return `${paths}${entry.resources.length > 3 ? `  +${entry.resources.length - 3} more` : ''}`;
	}
	const detail = entry.details.find((detail) => ['Error', 'Message', 'Summary', 'Output', 'Result'].includes(detail.label));
	return detail === undefined ? '' : detail.value.length > 180 ? `${detail.value.slice(0, 180)}...` : detail.value;
}

function appendFields(container, entry) {
	if (entry.resources.length > 0) {
		const files = element('ul', 'resource-list');
		for (const resource of entry.resources) {
			const item = element('li', undefined, resource.path);
			if (resource.count > 1) { item.append(element('span', 'repeat-count', ` ${resource.count} reads`)); }
			files.append(item);
		}
		container.append(files);
	}
	if (entry.tools.length > 0) {
		container.append(element('p', 'tool-identity', entry.tools.map((tool) => `${tool.server === undefined ? '' : `${tool.server} / `}${tool.name}${tool.method === undefined ? '' : ` (${tool.method})`}`).join(' | ')));
	}
	for (const detail of entry.details) {
		const field = element('details', 'activity-field');
		field.append(element('summary', undefined, detail.label), element('pre', undefined, detail.value));
		if (['Message', 'Summary', 'Error', 'Output'].includes(detail.label)) { field.open = true; }
		container.append(field);
	}
	for (const warning of entry.warnings) { container.append(element('p', 'capture-warning', warning)); }
	const source = element('details', 'source-details');
	source.append(element('summary', undefined, `${entry.sources.length} source ${entry.sources.length === 1 ? 'record' : 'records'} | ${[...new Set(entry.sources.map((source) => source.evidenceGrade))].join(', ')}`));
	source.append(element('pre', undefined, JSON.stringify({ id: entry.id, actor: entry.actor, parentId: entry.parentId, sources: entry.sources }, null, 2)));
	container.append(source);
}

function activityRow(entry) {
	const signature = JSON.stringify(entry);
	const cached = rows.get(entry.id);
	if (cached?.signature === signature) { return cached.element; }
	const item = element('li', 'activity-entry');
	item.dataset.activityId = entry.id;
	item.dataset.status = entry.status;
	item.dataset.category = entry.category;
	const record = element('details', 'activity-record');
	record.open = expanded.has(entry.id);
	const summary = element('summary', 'activity-heading');
	const time = element('time', 'activity-time', formatTimestamp(entry.startedAt));
	time.dateTime = entry.startedAt;
	time.title = entry.startedAt;
	if (entry.endedAt !== undefined && entry.endedAt !== entry.startedAt) {
		time.append(element('span', 'time-end', formatTimestamp(entry.endedAt)));
		time.title += ` .. ${entry.endedAt}`;
	}
	const heading = element('div', 'activity-title');
	heading.append(element('strong', undefined, entry.title));
	const description = preview(entry);
	if (description !== '') { heading.append(element('p', 'activity-preview', description)); }
	const state = element('span', 'activity-status', entry.status === 'info' ? entry.category.replaceAll('-', ' ') : entry.status);
	summary.append(time, heading, state);
	const body = element('div', 'activity-body');
	let populated = false;
	const populate = () => {
		if (populated || !record.open) { return; }
		populated = true;
		appendFields(body, entry);
	};
	populate();
	record.addEventListener('toggle', () => {
		if (!record.isConnected) { return; }
		if (record.open) { expanded.add(entry.id); } else { expanded.delete(entry.id); }
		populate();
	});
	record.append(summary, body);
	item.append(record);
	rows.set(entry.id, { signature, element: item });
	return item;
}

function matches(entry) {
	const selected = filter.value;
	if (selected === 'issues' && !['failed', 'interrupted', 'unknown'].includes(entry.status) && entry.warnings.length === 0) { return false; }
	if (selected === 'messages' && !['request', 'response', 'plan', 'reasoning-summary'].includes(entry.category)) { return false; }
	if (selected === 'command' && !['command', 'test'].includes(entry.category)) { return false; }
	if (!['all', 'issues', 'messages', 'command'].includes(selected) && entry.category !== selected) { return false; }
	const query = search.value.trim().toLocaleLowerCase();
	return query === '' || JSON.stringify(entry).toLocaleLowerCase().includes(query);
}

function renderTimeline() {
	if (selectedView === 'query') { return; }
	const entries = selectedView === 'spans' ? currentRun?.trace?.activity ?? [] : currentRun?.activity?.entries ?? [];
	const filtered = entries.filter(matches);
	const visible = filtered.slice(-VIEW_LIMIT);
	const follow = followLog.checked && nearBottom(timeline);
	const previousScrollTop = timeline.scrollTop;
	const focused = document.activeElement?.closest('[data-activity-id]')?.dataset.activityId;
	const fragment = document.createDocumentFragment();
	if (filtered.length > VIEW_LIMIT) { fragment.append(element('li', 'capture-warning', `Showing the latest ${VIEW_LIMIT} of ${filtered.length} matching activities.`)); }
	for (const entry of visible) { fragment.append(activityRow(entry)); }
	if (visible.length === 0) {
		fragment.append(element('li', 'empty-state', entries.length > 0 ? 'No matching activity.' : selectedView === 'spans' && activeRun !== undefined ? 'Spans are available after delivery.' : 'No captured activity.'));
	}
	timeline.replaceChildren(fragment);
	const currentIds = new Set(entries.map((entry) => entry.id));
	for (const id of rows.keys()) { if (!currentIds.has(id)) { rows.delete(id); } }
	activityCount.textContent = `${filtered.length} ${filtered.length === 1 ? 'activity' : 'activities'}${selectedView === 'activity' && currentRun ? ` / ${currentRun.activity.sourceCount} source events` : ''}`;
	if (focused) { rows.get(focused)?.element.querySelector('summary')?.focus({ preventScroll: true }); }
	timeline.scrollTop = follow ? timeline.scrollHeight : previousScrollTop;
}

function renderRun(run) {
	currentRun = run;
	queryScope.querySelector('[value="latest"]').disabled = run.traceId === undefined;
	renderTimeline();
	setDownload(run);
	runState.textContent = run.status;
	runState.dataset.state = run.status;
	traceCount.textContent = `${run.trace?.spanCount ?? 0} spans stored`;
	runDate.textContent = run.activity.entries[0]?.startedAt.slice(0, 10) ?? 'Execution';
	const summary = run.log.summary;
	captureSummary.textContent = `${summary.filesRead} files read | ${summary.directoriesInspected} directories | ${summary.failedActions} failed actions | ${run.delivery === false ? 'Delivery incomplete' : run.delivery === true ? 'Delivered locally' : 'Capturing'}`;
}

function setDownload(run) {
	if (!run.downloadReady) {
		downloadLink.removeAttribute('download');
		downloadLink.removeAttribute('href');
		downloadLink.setAttribute('aria-disabled', 'true');
		downloadLink.tabIndex = -1;
		return;
	}
	downloadLink.download = `model-worklog-run-${run.id}.json`;
	downloadLink.href = `/api/runs/${encodeURIComponent(run.id)}/download`;
	downloadLink.setAttribute('aria-disabled', 'false');
	downloadLink.tabIndex = 0;
}

async function readRun(runId) {
	const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: 'no-store' });
	if (!response.ok) {
		throw new Error('Unable to load the run timeline.');
	}
	return response.json();
}

async function updateRun() {
	if (activeRun === undefined) {
		return;
	}
	try {
		const run = await readRun(activeRun);
		renderRun(run);
		if (run.status === 'running') {
			pollTimer = window.setTimeout(updateRun, 180);
			return;
		}
		activeRun = undefined;
		setRunning(false);
		if (run.status === 'completed') {
			addMessage('assistant', run.response);
			if (pendingSampleQuery) {
				pendingSampleQuery = false;
				queryTool.value = '';
				queryIntent.value = 'auto';
				questionInput.value = 'What tools were used?';
				queryForm.requestSubmit();
			}
		} else {
			pendingSampleQuery = false;
			addMessage('assistant', `The run stopped: ${run.error ?? 'Unknown error'}`);
		}
	} catch (error) {
		activeRun = undefined;
		setRunning(false);
		runState.textContent = 'error';
		addMessage('assistant', error instanceof Error ? error.message : 'The run could not be displayed.');
	}
}

form.addEventListener('submit', async (event) => {
	event.preventDefault();
	const message = input.value.trim();
	if (!message || activeRun !== undefined) {
		return;
	}
	window.clearTimeout(pollTimer);
	currentRun = undefined;
	expanded.clear();
	rows.clear();
	addMessage('user', message);
	input.value = '';
	setRunning(true);
	runState.textContent = 'starting';
	runState.dataset.state = 'running';
	traceCount.textContent = '0 spans stored';
	captureSummary.textContent = 'Starting';
	timeline.replaceChildren(element('li', 'empty-state', 'Starting capture...'));
	try {
		const response = await fetch('/api/chat', {
			body: JSON.stringify({ message }),
			headers: { 'content-type': 'application/json' },
			method: 'POST',
		});
		const payload = await response.json();
		if (!response.ok) {
			throw new Error(payload?.error?.message ?? 'Unable to start the run.');
		}
		activeRun = payload.runId;
		void updateRun();
	} catch (error) {
		setRunning(false);
		runState.textContent = 'error';
		addMessage('assistant', error instanceof Error ? error.message : 'Unable to start the run.');
	}
});

search.addEventListener('input', renderTimeline);
filter.addEventListener('change', renderTimeline);
document.querySelectorAll('input[name="log-view"]').forEach((control) => {
	control.addEventListener('change', () => {
		selectedView = control.value;
		const querying = selectedView === 'query';
		queryPanel.hidden = !querying;
		for (const target of ['.log-filters', '.log-caption', '#timeline', '.log-footer', '.follow-control']) { document.querySelector(target).hidden = querying; }
		if (querying) { questionInput.focus(); } else { renderTimeline(); }
	});
});
followLog.addEventListener('change', () => { if (followLog.checked) { timeline.scrollTop = timeline.scrollHeight; } });

function renderToolCounts(tools) {
	const table = element('table', 'query-tools');
	const heading = element('tr');
	for (const title of ['Tool', 'Calls', 'Failed', 'Running']) { heading.append(element('th', undefined, title)); }
	const head = element('thead');
	head.append(heading);
	const body = element('tbody');
	for (const tool of tools) {
		const row = element('tr');
		const name = element('td');
		const button = element('button', 'query-tool-name', tool.name);
		button.type = 'button';
		button.title = `Query usage of ${tool.name}`;
		button.addEventListener('click', () => { queryTool.value = tool.name; questionInput.value = `How many times was ${tool.name} used?`; queryIntent.value = 'tools'; queryForm.requestSubmit(); });
		name.append(button);
		row.append(name, element('td', undefined, String(tool.calls)), element('td', undefined, String(tool.failed)), element('td', undefined, String(tool.running)));
		body.append(row);
	}
	table.append(head, body);
	return table;
}

function renderEvidence(source) {
	const details = element('details', 'query-source');
	details.append(element('summary', undefined, `[${source.id}] ${source.name} / ${source.state}`));
	const content = element('div', 'query-source-content');
	content.append(element('p', 'query-source-meta', `${source.startedAt} | ${source.serviceName} | revision ${source.revision}`));
	content.append(element('pre', undefined, source.excerpt));
	const open = element('button', 'query-open-source', 'Open source');
	open.type = 'button';
	open.title = 'Read the retained span behind this citation';
	open.addEventListener('click', async () => {
		open.disabled = true;
		try {
			const params = new URLSearchParams({ traceId: source.traceId, spanId: source.spanId });
			const response = await fetch(`/api/logs/evidence?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
			const payload = await response.json();
			if (!response.ok) { throw new Error(payload?.error?.message ?? 'Evidence is unavailable.'); }
			if (payload.span.revision !== source.revision) { content.append(element('p', 'capture-warning', `The retained span has advanced to revision ${payload.span.revision}. The excerpt above is the query snapshot at revision ${source.revision}.`)); }
			content.append(element('pre', 'query-source-record', JSON.stringify(payload, null, 2)));
			open.remove();
		} catch (error) {
			content.append(element('p', 'query-error', error instanceof Error ? error.message : 'Evidence is unavailable.'));
			open.disabled = false;
		}
	});
	content.append(open);
	details.append(content);
	return details;
}

function renderAnswer(answer) {
	const fragment = document.createDocumentFragment();
	const metrics = element('dl', 'query-metrics');
	for (const [label, value] of [['Tool calls', answer.totals.toolCalls], ['Failed spans', answer.totals.failedSpans], ['Scoped spans', answer.totals.spans], ['Citations', answer.evidence.length]]) {
		const item = element('div');
		item.append(element('dt', undefined, label), element('dd', undefined, String(value)));
		metrics.append(item);
	}
	fragment.append(metrics, element('pre', 'query-answer', answer.answer));
	if (answer.tools.length > 0) { fragment.append(renderToolCounts(answer.tools)); }
	if (answer.evidence.length > 0) {
		fragment.append(element('h3', 'query-section-title', 'Sources'));
		for (const source of answer.evidence) { fragment.append(renderEvidence(source)); }
	}
	const limitations = element('details', 'query-limitations');
	limitations.append(element('summary', undefined, `Coverage notes (${answer.limitations.length})`));
	for (const limitation of answer.limitations) { limitations.append(element('p', undefined, limitation)); }
	fragment.append(limitations);
	queryResult.replaceChildren(fragment);
	queryStatus.textContent = `${answer.retrieval.matchedSpans} matches | ${answer.generation.status === 'generated' ? 'Model interpretation' : answer.retrieval.strategy} | ${answer.snapshotAt.slice(11, 19)} UTC`;
}

queryForm.addEventListener('submit', async (event) => {
	event.preventDefault();
	const question = questionInput.value.trim();
	if (question === '') { return; }
	const requestId = ++queryRequestId;
	askButton.disabled = true;
	queryExport.disabled = true;
	latestAnswer = undefined;
	queryResult.replaceChildren();
	queryError.hidden = true;
	queryStatus.textContent = 'Querying retained logs...';
	const body = { question, intent: queryIntent.value, synthesis: document.querySelector('#query-model').checked ? 'model' : 'extractive' };
	if (queryScope.value === 'latest' && currentRun?.traceId !== undefined) { body.traceId = currentRun.traceId; }
	if (queryTool.value.trim() !== '') { body.toolName = queryTool.value.trim(); }
	try {
		for (const field of ['since', 'until']) {
			const value = document.querySelector(`#query-${field}`).value;
			if (value !== '') { body[field] = new Date(value).toISOString(); }
		}
		const response = await fetch('/api/logs/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
		const payload = await response.json();
		if (requestId !== queryRequestId) { return; }
		if (!response.ok) { throw new Error(payload?.error?.message ?? 'The log query failed.'); }
		latestAnswer = payload;
		renderAnswer(payload);
		queryExport.disabled = false;
	} catch (error) {
		if (requestId !== queryRequestId) { return; }
		queryError.textContent = error instanceof Error ? error.message : 'The log query failed.';
		queryError.hidden = false;
		queryStatus.textContent = 'Query failed';
	} finally { if (requestId === queryRequestId) { askButton.disabled = false; } }
});

sampleButton.addEventListener('click', async () => {
	if (activeRun !== undefined) { return; }
	setRunning(true);
	queryError.hidden = true;
	queryStatus.textContent = 'Recording sample capture...';
	try {
		const response = await fetch('/api/logs/sample', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(15_000) });
		const payload = await response.json();
		if (!response.ok) { throw new Error(payload?.error?.message ?? 'Sample capture failed.'); }
		activeRun = payload.runId;
		pendingSampleQuery = true;
		addMessage('user', 'Record inventory sample capture');
		queryScope.querySelector('[value="latest"]').disabled = false;
		queryScope.value = 'latest';
		void updateRun();
	} catch (error) {
		setRunning(false);
		queryError.textContent = error instanceof Error ? error.message : 'Sample capture failed.';
		queryError.hidden = false;
		queryStatus.textContent = 'Sample capture failed';
	}
});

queryExport.addEventListener('click', () => {
	if (latestAnswer === undefined) { return; }
	const url = URL.createObjectURL(new Blob([JSON.stringify(latestAnswer, null, 2)], { type: 'application/json' }));
	const link = document.createElement('a');
	link.href = url;
	link.download = 'model-worklog-answer.json';
	document.body.append(link);
	link.click();
	link.remove();
	window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
});

async function loadConfig() {
	try {
		const response = await fetch('/api/config', { cache: 'no-store' });
		if (!response.ok) {
			throw new Error('Configuration unavailable');
		}
		const config = await response.json();
		document.querySelector('#query-model-control').hidden = !config.modelSynthesis;
		providerMode.textContent = config.mode === 'copilot' ? 'GitHub Copilot' : config.mode === 'openai-compatible' ? 'Live provider' : 'Offline demo';
		connectionStatus.textContent = `${config.provider} / Local collector`;
		workspaceContext.textContent = `${config.workspace.label}: ${config.workspace.files.join(', ')}`;
	} catch {
		connectionStatus.textContent = 'Local collector unavailable';
	}
}

void loadConfig();