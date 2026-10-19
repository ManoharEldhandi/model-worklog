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

let activeRun;
let pollTimer;
let currentRun;
let selectedView = 'activity';
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
	input.disabled = running;
	if (running) {
		setDownload({ downloadReady: false });
	}
	if (!running) {
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
		} else {
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
	control.addEventListener('change', () => { selectedView = control.value; renderTimeline(); });
});
followLog.addEventListener('change', () => { if (followLog.checked) { timeline.scrollTop = timeline.scrollHeight; } });

async function loadConfig() {
	try {
		const response = await fetch('/api/config', { cache: 'no-store' });
		if (!response.ok) {
			throw new Error('Configuration unavailable');
		}
		const config = await response.json();
		providerMode.textContent = config.mode === 'copilot' ? 'GitHub Copilot' : config.mode === 'openai-compatible' ? 'Live provider' : 'Offline demo';
		connectionStatus.textContent = `${config.provider} / Local collector`;
		workspaceContext.textContent = `${config.workspace.label}: ${config.workspace.files.join(', ')}`;
	} catch {
		connectionStatus.textContent = 'Local collector unavailable';
	}
}

void loadConfig();