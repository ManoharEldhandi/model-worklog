import { markdownContent } from './markdown.js';

function node(tag, className, text) {
	const element = document.createElement(tag);
	if (className !== undefined) { element.className = className; }
	if (text !== undefined) { element.textContent = text; }
	return element;
}

function recentHistory(turns) {
	const messages = turns.filter((turn) => turn.answer !== undefined).flatMap((turn) => [{ role: 'user', content: turn.question.slice(0, 4000) }, { role: 'assistant', content: turn.answer.answer.slice(0, 4000) }]).slice(-12);
	while (messages.reduce((total, message) => total + message.content.length, 0) > 16_000) { messages.splice(0, 2); }
	return messages;
}

function toolTable(tools) {
	const table = node('table', 'query-tools');
	const header = node('tr');
	for (const title of ['Tool', 'Calls', 'Failed', 'Running']) { header.append(node('th', undefined, title)); }
	const head = node('thead');
	head.append(header);
	const body = node('tbody');
	for (const tool of tools) {
		const row = node('tr');
		for (const value of [tool.name, tool.calls, tool.failed, tool.running]) { row.append(node('td', undefined, String(value))); }
		body.append(row);
	}
	table.append(head, body);
	return table;
}

function aggregateSource(answer, prefix) {
	const source = node('details', 'query-source');
	source.id = `${prefix}-A1`;
	source.append(node('summary', undefined, '[A1] Exact scoped aggregates'));
	const metrics = node('dl', 'query-metrics');
	for (const [label, value] of [['Tool calls', answer.totals.toolCalls], ['Failed spans', answer.totals.failedSpans], ['Retained spans', answer.totals.spans], ['Traces', answer.totals.traces]]) {
		const item = node('div');
		item.append(node('dt', undefined, label), node('dd', undefined, String(value)));
		metrics.append(item);
	}
	source.append(metrics);
	if (answer.overview !== undefined) {
		const overview = answer.overview;
		source.append(node('p', 'query-source-meta', `Models: ${overview.models.join(', ') || 'Not reported'} | Tokens: ${overview.reportedTokens ?? 'Not reported'}${overview.reportedTokens !== undefined && !overview.usageComplete ? ' (reported subtotal)' : ''}`));
		if (overview.firstSeen !== null) { source.append(node('p', 'query-source-meta', `${overview.firstSeen} to ${overview.lastSeen}`)); }
	}
	if (answer.tools.length > 0) { source.append(toolTable(answer.tools)); }
	return source;
}

function spanSource(source, prefix) {
	const details = node('details', 'query-source');
	details.id = `${prefix}-${source.id}`;
	details.append(node('summary', undefined, `[${source.id}] ${source.name} / ${source.state}`));
	const content = node('div', 'query-source-content');
	content.append(node('p', 'query-source-meta', `${source.startedAt} | ${source.serviceName} | revision ${source.revision}`), node('pre', undefined, source.excerpt));
	if (source.excerptTruncated) { content.append(node('p', 'capture-warning', 'This excerpt was shortened.'));
	}
	const open = node('button', 'query-open-source', 'Open retained source');
	open.type = 'button';
	open.addEventListener('click', async () => {
		open.disabled = true;
		try {
			const params = new URLSearchParams({ traceId: source.traceId, spanId: source.spanId });
			const response = await fetch(`/api/logs/evidence?${params}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
			const payload = await response.json();
			if (!response.ok) { throw new Error(payload?.error?.message ?? 'The retained source is unavailable.'); }
			if (payload.span.revision !== source.revision) { content.append(node('p', 'capture-warning', `The retained source is now revision ${payload.span.revision}; the answer used revision ${source.revision}.`)); }
			content.append(node('pre', 'query-source-record', JSON.stringify(payload, null, 2)));
			open.remove();
		} catch (error) { content.append(node('p', 'query-error', error.message)); open.disabled = false; }
	});
	content.append(open);
	details.append(content);
	return details;
}

function sourceDetails(answer, prefix) {
	const details = node('details', 'query-evidence');
	details.append(node('summary', undefined, `Evidence and coverage (${answer.evidence.length} records)`));
	const citations = new Map();
	const aggregate = aggregateSource(answer, prefix);
	details.append(aggregate);
	citations.set('A1', aggregate);
	for (const source of answer.evidence) { const element = spanSource(source, prefix); details.append(element); citations.set(source.id, element); }
	const warnings = node('details', 'query-limitations');
	warnings.append(node('summary', undefined, 'Coverage notes'));
	for (const limitation of answer.limitations) { warnings.append(node('p', undefined, limitation)); }
	details.append(warnings);
	return { details, citations };
}

export function createLogConversation({ getTraceId }) {
	const form = document.querySelector('#query-form');
	const input = document.querySelector('#question');
	const scope = document.querySelector('#query-scope');
	const result = document.querySelector('#query-result');
	const status = document.querySelector('#query-status');
	const error = document.querySelector('#query-error');
	const submit = document.querySelector('#ask-button');
	const stop = document.querySelector('#query-stop');
	const model = document.querySelector('#query-model');
	const exportButton = document.querySelector('#query-export');
	let turns = [];
	let pending;
	let sequence = 0;
	let scopeKey;
	let modelLabel = 'Assistant';

	function selection() {
		const body = { intent: document.querySelector('#query-intent').value, synthesis: model.checked ? 'model' : 'extractive', limit: 12 };
		if (scope.value === 'latest' && getTraceId() === undefined) { throw new Error('The current capture is not available yet. Wait for delivery or select all retained traces.'); }
		if (scope.value === 'latest' && getTraceId() !== undefined) { body.traceId = getTraceId(); }
		const tool = document.querySelector('#query-tool').value.trim();
		if (tool !== '') { body.toolName = tool; }
		for (const field of ['since', 'until']) { const value = document.querySelector(`#query-${field}`).value; if (value !== '') { body[field] = new Date(value).toISOString(); } }
		if (body.since !== undefined && body.until !== undefined && body.since > body.until) { throw new Error('The start time must not be after the end time.'); }
		return body;
	}

	function busy(value) {
		submit.disabled = value;
		stop.hidden = !value;
		model.disabled = value;
		form.setAttribute('aria-busy', String(value));
	}

	function clear(message = 'New conversation') {
		pending?.controller.abort();
		pending = undefined;
		sequence += 1;
		turns = [];
		result.replaceChildren(node('p', 'empty-state', 'No messages yet.'));
		error.hidden = true;
		exportButton.disabled = true;
		busy(false);
		status.textContent = message;
	}

	function syncScope() {
		const key = JSON.stringify({ scope: scope.value, traceId: scope.value === 'latest' ? getTraceId() : undefined, tool: document.querySelector('#query-tool').value, since: document.querySelector('#query-since').value, until: document.querySelector('#query-until').value, intent: document.querySelector('#query-intent').value });
		if (scopeKey !== undefined && scopeKey !== key) { clear('Scope changed'); }
		scopeKey = key;
	}

	function newTurn(question) {
		result.querySelector('.empty-state')?.remove();
		const element = node('article', 'log-turn');
		const user = node('div', 'log-message log-user');
		const text = node('p', 'log-question', question);
		user.append(node('p', 'message-label', 'You'), text);
		const assistant = node('div', 'log-message log-assistant');
		const label = node('p', 'message-label', model.checked ? modelLabel : 'Evidence');
		const body = node('div', 'query-answer markdown');
		body.append(node('p', 'answer-pending', 'Retrieving relevant logs...'));
		assistant.append(label, body);
		element.append(user, assistant);
		result.append(element);
		const turn = { question, element, text, assistant, label, body, history: recentHistory(turns) };
		turns.push(turn);
		if (turns.length > 20) { turns.shift().element.remove(); }
		result.scrollTop = result.scrollHeight;
		return turn;
	}

	function showAnswer(turn, answer) {
		turn.answer = answer;
		turn.question = answer.question ?? turn.question;
		turn.text.textContent = turn.question;
		turn.label.textContent = answer.generation.status === 'generated' ? answer.generation.provider === 'github-copilot' ? 'Copilot' : 'Assistant' : answer.generation.status === 'fallback' ? 'Evidence fallback' : 'Evidence';
		const sources = sourceDetails(answer, `turn-${++sequence}`);
		turn.body.replaceChildren(markdownContent(answer.answer, sources.citations));
		turn.assistant.append(node('p', 'answer-provenance', `${answer.evidence.length} evidence records | ${answer.snapshotAt.slice(11, 19)} UTC${answer.retrieval.contextExpanded ? ' | contextual retrieval' : ''}`), sources.details);
		status.textContent = answer.generation.status === 'generated' ? 'Answered from captured logs' : answer.generation.status === 'fallback' ? 'AI unavailable; evidence fallback' : 'Evidence-only answer';
		exportButton.disabled = false;
	}

	function showFailure(turn, failure, cancelled) {
		turn.body.replaceChildren(node('p', cancelled ? 'answer-provenance' : 'query-error', cancelled ? 'Answer stopped.' : failure.message ?? 'The answer could not be completed.'));
		const retry = node('button', 'query-retry', 'Retry');
		retry.type = 'button';
		retry.addEventListener('click', () => ask(turn.question));
		turn.body.append(retry);
		status.textContent = cancelled ? 'Stopped' : 'Answer failed';
	}

	async function ask(question = input.value.trim()) {
		if (question === '' || pending !== undefined) { return; }
		let body;
		try { syncScope(); body = selection(); }
		catch (failure) { error.textContent = failure.message; error.hidden = false; return; }
		error.hidden = true;
		const turn = newTurn(question);
		input.value = '';
		const request = { controller: new AbortController() };
		pending = request;
		busy(true);
		status.textContent = 'Answering from captured logs...';
		try {
			const response = await fetch('/api/logs/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, question, history: turn.history }), signal: AbortSignal.any([request.controller.signal, AbortSignal.timeout(60_000)]) });
			const answer = await response.json();
			if (pending !== request) { return; }
			if (!response.ok) { throw new Error(answer?.error?.message ?? 'The log conversation failed.'); }
			showAnswer(turn, answer);
		} catch (failure) { if (pending === request) { showFailure(turn, failure, request.controller.signal.aborted); } }
		finally { if (pending === request) { pending = undefined; busy(false); input.focus({ preventScroll: true }); } }
	}

	form.addEventListener('submit', (event) => { event.preventDefault(); void ask(); });
	input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); if (!submit.disabled) { form.requestSubmit(); } } });
	stop.addEventListener('click', () => pending?.controller.abort());
	document.querySelector('#query-new').addEventListener('click', () => { clear(); input.focus(); });
	for (const selector of ['#query-scope', '#query-tool', '#query-since', '#query-until', '#query-intent']) { document.querySelector(selector).addEventListener('change', syncScope); }
	exportButton.addEventListener('click', () => {
		const completed = turns.filter((turn) => turn.answer !== undefined).map((turn) => ({ question: turn.question, response: turn.answer }));
		if (completed.length === 0) { return; }
		const url = URL.createObjectURL(new Blob([JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), turns: completed }, null, 2)], { type: 'application/json' }));
		const link = node('a');
		link.href = url;
		link.download = 'model-worklog-conversation.json';
		document.body.append(link); link.click(); link.remove();
		setTimeout(() => URL.revokeObjectURL(url), 1000);
	});
	return {
		ask, clear, syncScope,
		configure(config) {
			modelLabel = config.mode === 'copilot' ? 'Copilot' : 'Assistant';
			document.querySelector('#query-model-control').hidden = !config.modelSynthesis;
			document.querySelector('#query-model-label').textContent = config.mode === 'copilot' ? 'Copilot answers' : 'Model answers';
			model.checked = config.modelSynthesis && config.mode === 'copilot';
		},
	};
}
