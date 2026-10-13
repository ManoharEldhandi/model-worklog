import { SpanKindSchema, SpanLinkSchema, type CaptureReport, type JsonObject, type SpanEvent, type SpanLink, type SpanUsage, type TraceSpan } from 'model-worklog-schema';

import type { TokenUsageMapping, UsageProviderSelector } from '../usage';
import type { TraceContext } from './context';
import { emptyReport, label, mergeReport, safeAttributes, safeUsage } from './privacy';
import type { TraceProcessor } from './processor';
import type { SpanOptions, TraceSpanHandle } from './types';
import { providerUsage } from './usage';

export class ModelSpan implements TraceSpanHandle {
	private readonly startedAt = new Date().toISOString();
	private readonly name: string;
	private readonly kind: TraceSpan['kind'];
	private readonly links: SpanLink[];
	private readonly capture: CaptureReport;
	private attributes: JsonObject = {};
	private readonly events: SpanEvent[] = [];
	private eventBytes = 0;
	private usage?: SpanUsage;
	private ended = false;
	private revision = 0;

	constructor(
		readonly context: TraceContext,
		private readonly parent: TraceContext | undefined,
		private readonly identity: { readonly projectId: string; readonly serviceName: string },
		private readonly processor: TraceProcessor,
		options: SpanOptions,
		private readonly enabled = true,
	) {
		this.name = label(options.name, 256, 'span');
		this.kind = SpanKindSchema.parse(options.kind ?? 'custom');
		this.links = (options.links ?? []).slice(0, 128).map((link) => SpanLinkSchema.parse(link));
		this.capture = emptyReport(processor.settings);
		this.setAttributes(options.attributes);
		if (options.input !== undefined) { this.captureInput(options.input); }
		this.publish('running');
	}

	guard(operation: () => void): void {
		if (this.ended || !this.enabled) { return; }
		try { operation(); }
		catch {
			this.capture.truncatedFields += 1;
			this.processor.diagnostics.emit({ code: 'serialization_failed', count: 1 });
		}
	}

	setAttribute(name: string, value: unknown): void { this.guard(() => this.setAttributes({ [name]: value })); }

	setAttributes(attributes: unknown): void {
		this.guard(() => {
			const clean = safeAttributes(attributes, this.processor.settings);
			mergeReport(this.capture, clean.report);
			const merged = safeAttributes({ ...this.attributes, ...clean.attributes }, this.processor.settings);
			mergeReport(this.capture, merged.report);
			this.attributes = merged.attributes;
		});
	}

	addEvent(name: string, attributes: unknown = {}): void {
		this.guard(() => {
			if (this.events.length >= this.processor.settings.maxEvents) { this.capture.droppedEvents += 1; return; }
			const clean = safeAttributes(attributes, this.processor.settings);
			mergeReport(this.capture, clean.report);
			const event = { name: label(name, 256, 'event'), at: new Date().toISOString(), attributes: clean.attributes };
			const bytes = Buffer.byteLength(JSON.stringify(event));
			if (this.eventBytes + bytes > this.processor.settings.maxSpanBytes / 2) { this.capture.droppedEvents += 1; return; }
			this.eventBytes += bytes;
			this.events.push(event);
		});
	}

	setUsage(usage: SpanUsage): void { this.guard(() => { this.usage = safeUsage(usage); }); }

	recordProviderUsage(provider: UsageProviderSelector, response: unknown, mapping?: TokenUsageMapping): void {
		this.guard(() => {
			const usage = providerUsage(provider, response, mapping);
			if (usage === undefined) { this.processor.diagnostics.emit({ code: 'usage_unavailable' }); }
			else { this.usage = safeUsage(usage); }
		});
	}

	captureInput(input: unknown): void { this.setAttribute('input', input); }
	captureOutput(output: unknown): void { this.setAttribute('output', output); }

	end(state: Exclude<TraceSpan['state'], 'running'>): void {
		if (this.ended) { return; }
		this.publish(state);
		this.ended = true;
	}

	private publish(state: TraceSpan['state']): void {
		if (!this.enabled) { return; }
		this.processor.enqueue({
			schemaVersion: 1, projectId: this.identity.projectId, serviceName: this.identity.serviceName,
			traceId: this.context.traceId, spanId: this.context.spanId,
			...(this.parent === undefined ? {} : { parentSpanId: this.parent.spanId }),
			name: this.name, kind: this.kind, revision: ++this.revision, state, startedAt: this.startedAt,
			...(state === 'running' ? {} : { endedAt: new Date(Math.max(Date.now(), Date.parse(this.startedAt))).toISOString() }),
			attributes: this.attributes, events: this.events, links: this.links, usage: this.usage, capture: this.capture,
		});
	}
}