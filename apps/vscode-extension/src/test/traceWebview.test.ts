import * as assert from 'assert';
import { runInNewContext } from 'node:vm';
import { traceDetailsHtml } from '../traceDetailsHtml';
import { TraceController } from '../traceController';
import { presentTraceDetail, type TraceDetailModel } from '../tracePresentation';
import { storedSpan, traceId, traceSummary } from './traceFixtures';

class TestElement {
	textContent = '';
	className = '';
	dataset: Record<string, string> = {};
	children: TestElement[] = [];
	parent: TestElement | undefined;
	open = false;
	hidden = false;
	disabled = false;
	scrollTop = 0;
	private readonly listeners = new Map<string, () => void>();
	constructor(readonly tagName: string) {}
	set innerHTML(_value: string) { throw new Error('Untrusted HTML insertion'); }
	get isConnected(): boolean { return this.tagName === 'main' || this.parent?.isConnected === true; }
	append(...children: TestElement[]): void { for (const child of children) { child.parent = this; this.children.push(child); } }
	replaceChildren(...children: TestElement[]): void { for (const child of this.children) { child.parent = undefined; } this.children = []; this.append(...children); }
	addEventListener(event: string, listener: () => void): void { this.listeners.set(event, listener); }
	dispatch(event: string): void { this.listeners.get(event)?.(); }
	setAttribute(): void {}
	focus(): void {}
	closest(tag: string): TestElement | undefined { return this.tagName === tag ? this : this.parent?.closest(tag); }
	find(id: string): TestElement | undefined { return this.dataset.spanId === id ? this : this.children.map((child) => child.find(id)).find(Boolean); }
	allText(): string { return [this.textContent, ...this.children.map((child) => child.allText())].join('\n'); }
}

function renderer() {
	const script = /<script nonce="[^"]+">([\s\S]*)<\/script>/.exec(traceDetailsHtml())?.[1];
	assert.ok(script);
	const content = new TestElement('main');
	const elements = new Map(['title', 'meta', 'status', 'warnings', 'more'].map((id) => [id, new TestElement('div')]));
	elements.set('content', content);
	let receive!: (event: { data: { type: string; model: TraceDetailModel } }) => void;
	let persisted: unknown;
	runInNewContext(script, {
		acquireVsCodeApi: () => ({ getState: () => undefined, setState: (value: unknown) => { persisted = value; }, postMessage: () => undefined }),
		document: { getElementById: (id: string) => elements.get(id), createElement: (tag: string) => new TestElement(tag), documentElement: new TestElement('html') },
		window: { addEventListener: (_type: string, listener: typeof receive) => { receive = listener; } },
	});
	return { content, render: (model: TraceDetailModel) => receive({ data: { type: 'render', model } }), state: () => persisted };
}

suite('Trace webview safety and stable expansion', () => {
	test('has a strict nonce CSP, no network assets and valid standalone script', () => {
		const markup = traceDetailsHtml();
		assert.match(markup, /default-src 'none'; base-uri 'none'; form-action 'none'/);
		assert.ok(!markup.includes('unsafe-inline'));
		assert.ok(!markup.includes('innerHTML'));
		assert.ok(!markup.includes('https://'));
		assert.doesNotThrow(renderer);
	});

	test('renders literal hostile text and preserves expansion by span ID through reordering and revisions', () => {
		const controller = new TraceController('app');
		const hostile = '<img src=x onerror="alert(1)"><script>attack()</script>';
		const first = storedSpan({ name: hostile, attributes: { output: hostile } });
		const child = storedSpan({ spanId: '2'.repeat(16), parentSpanId: first.span.spanId });
		const state = { ...controller.state, enabled: true, phase: 'ready' as const, principal: { id: 'admin', role: 'admin' as const, projects: ['*'] },
			selectedTraceId: traceId, traces: [traceSummary()], spans: [child, first], detailPhase: 'ready' as const };
		const view = renderer();
		view.render(presentTraceDetail(state));
		const parent = view.content.find(first.span.spanId);
		assert.ok(parent);
		parent.open = true;
		parent.dispatch('toggle');
		assert.match(view.content.allText(), /<script>attack\(\)<\/script>/);
		assert.ok(view.content.allText().includes(hostile));
		assert.ok(view.content.find(child.span.spanId)?.parent?.parent === parent);
		view.render(presentTraceDetail({ ...state, spans: [{ ...first, span: { ...first.span, revision: 3 } }, child] }));
		assert.strictEqual(view.content.find(first.span.spanId)?.open, true);
		assert.ok(JSON.stringify(view.state()).includes(first.span.spanId));
		view.render(presentTraceDetail({ ...state, projectId: 'other' }));
		assert.strictEqual(view.content.find(first.span.spanId)?.open, false);
		controller.dispose();
	});

	test('projects no auth data and hides captured content from denied identities', () => {
		const controller = new TraceController('app');
		const state = { ...controller.state, enabled: true, principal: { id: 'credential-id', role: 'writer' as const, projects: ['app'] },
			selectedTraceId: traceId, spans: [storedSpan({ name: 'private content' })], detailPhase: 'unauthorized' as const, detailNotice: 'Trace access denied.' };
		const model = presentTraceDetail(state);
		assert.deepStrictEqual(model.spans, []);
		assert.ok(!JSON.stringify(model).includes('credential-id'));
		assert.ok(!JSON.stringify(model).includes('private content'));
		assert.match(model.notice, /denied/);
		controller.dispose();
	});
});