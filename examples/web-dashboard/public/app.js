const form = document.querySelector('#chat-form');
const input = document.querySelector('#message');
const sendButton = document.querySelector('#send-button');
const messages = document.querySelector('#messages');
const timeline = document.querySelector('#timeline');
const spanList = document.querySelector('#span-list');
const runState = document.querySelector('#run-state');
const traceCount = document.querySelector('#trace-count');
const downloadLink = document.querySelector('#download-link');
const providerMode = document.querySelector('#provider-mode');
const connectionStatus = document.querySelector('#connection-status');
const workspaceContext = document.querySelector('#workspace-context');

let activeRun;
let pollTimer;
const DETAIL_LIMIT = 220;

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
	const value = new Date(timestamp);
	const part = (number, length = 2) => String(number).padStart(length, '0');
	return `${part(value.getHours())}:${part(value.getMinutes())}:${part(value.getSeconds())}.${part(value.getMilliseconds(), 3)}`;
}

function addDetail(item, detail) {
	const output = element('pre', 'terminal-detail');
	const full = String(detail);
	const collapsed = full.length > DETAIL_LIMIT;
	output.textContent = collapsed ? `${full.slice(0, DETAIL_LIMIT)}\n[${full.length - DETAIL_LIMIT} more characters redacted from this view]` : full;
	item.append(output);
	if (!collapsed) {
		return;
	}
	const toggle = element('button', 'log-toggle', 'Show more');
	toggle.type = 'button';
	toggle.addEventListener('click', () => {
		const expanded = toggle.dataset.expanded === 'true';
		toggle.dataset.expanded = String(!expanded);
		toggle.textContent = expanded ? 'Show more' : 'Show less';
		output.textContent = expanded ? `${full.slice(0, DETAIL_LIMIT)}\n[${full.length - DETAIL_LIMIT} more characters redacted from this view]` : full;
	});
	item.append(toggle);
}

function renderTimeline(events) {
	const follow = nearBottom(timeline);
	const previousScrollTop = timeline.scrollTop;
	timeline.replaceChildren();
	if (events.length === 0) {
		timeline.append(element('li', 'empty-state', 'Starting trace...'));
		return;
	}
	for (const event of events) {
		const item = element('li', 'terminal-line');
		const meta = element('time', 'terminal-time', formatTimestamp(event.at));
		const heading = element('span', 'terminal-event', event.message);
		item.append(meta, heading);
		if (event.detail) {
			addDetail(item, event.detail);
		}
		timeline.append(item);
	}
	timeline.scrollTop = follow ? timeline.scrollHeight : previousScrollTop;
}

function renderTrace(trace) {
	spanList.replaceChildren();
	const spans = trace?.spans ?? [];
	traceCount.textContent = `${spans.length} ${spans.length === 1 ? 'span' : 'spans'}`;
	if (spans.length === 0) {
		spanList.append(element('p', 'empty-state', 'Trace data is being stored locally.'));
		return;
	}
	for (const span of spans) {
		const item = element('div', 'span-item');
		const title = element('strong', undefined, span.name);
		const details = [span.kind, span.state, span.durationMs === undefined ? undefined : `${span.durationMs} ms`].filter(Boolean).join(' | ');
		item.append(title, element('span', undefined, details));
		spanList.append(item);
	}
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
		renderTimeline(run.events);
		renderTrace(run.trace);
		setDownload(run);
		runState.textContent = run.status;
		runState.dataset.state = run.status;
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
	addMessage('user', message);
	input.value = '';
	setRunning(true);
	runState.textContent = 'starting';
	traceCount.textContent = '0 spans';
	spanList.replaceChildren(element('p', 'empty-state', 'Waiting for the SDK trace.'));
	timeline.replaceChildren(element('li', 'empty-state', 'Starting trace...'));
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

async function loadConfig() {
	try {
		const response = await fetch('/api/config', { cache: 'no-store' });
		if (!response.ok) {
			throw new Error('Configuration unavailable');
		}
		const config = await response.json();
		providerMode.textContent = config.mode === 'copilot' ? 'GitHub Copilot' : config.mode === 'openai-compatible' ? 'Live provider' : 'Offline demo';
		connectionStatus.textContent = `${config.collector} | ${config.provider}`;
		workspaceContext.textContent = `${config.workspace.label}: ${config.workspace.files.join(', ')}`;
	} catch {
		connectionStatus.textContent = 'Local collector unavailable';
	}
}

void loadConfig();