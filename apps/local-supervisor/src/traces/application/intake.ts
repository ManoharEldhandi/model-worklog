import { PrivacyPolicySchema, TraceBatchAckSchema, TraceBatchSchema, type PrivacyOptions, type TraceBatchAck, type TracePrincipal } from 'model-worklog-schema';

import { TraceError, type PreparedSpan, type SecretCodec, type TraceRepository } from '../domain/contracts';
import { sanitizeSpan } from '../domain/privacy';
import { requireProject, requireRole } from './credentials';

function canonical(value: unknown): string {
	if (Array.isArray(value)) { return `[${value.map((entry: unknown) => canonical(entry)).join(',')}]`; }
	if (value !== null && typeof value === 'object') {
		return `{${Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
	}
	const encoded = JSON.stringify(value);
	if (encoded === undefined) { throw new Error('Invalid canonical trace value.'); }
	return encoded;
}

export class TraceIntake {
	private readonly privacy: PrivacyOptions;

	constructor(private readonly repository: TraceRepository, private readonly secrets: SecretCodec, privacy: PrivacyOptions, private readonly now: () => Date, private readonly retentionTtlSeconds?: number) {
		this.privacy = PrivacyPolicySchema.parse(privacy);
	}

	ingest(principal: TracePrincipal, input: unknown): TraceBatchAck {
		requireRole(principal, ['writer', 'admin']);
		const parsed = TraceBatchSchema.safeParse(input);
		if (!parsed.success) { throw new TraceError(400, 'invalid_batch', 'Expected a strict schemaVersion 1 trace batch with 1 to 100 valid spans.'); }
		for (const span of parsed.data.spans) { requireProject(principal, span.projectId); }
		const spans: PreparedSpan[] = parsed.data.spans.map((span) => ({
			span: sanitizeSpan(span, this.privacy),
			contentHash: this.secrets.digest(canonical(span)),
			identityHash: this.secrets.digest(canonical({ projectId: span.projectId, traceId: span.traceId, spanId: span.spanId, parentSpanId: span.parentSpanId, startedAt: span.startedAt, name: span.name, serviceName: span.serviceName, kind: span.kind })),
			...(span.usage?.provider === undefined || span.usage.requestId === undefined ? {} : { usageKey: this.secrets.digest(canonical([span.usage.provider, span.usage.requestId])) }),
		}));
		const now = this.now();
		const before = this.retentionTtlSeconds === undefined ? undefined : new Date(now.getTime() - this.retentionTtlSeconds * 1_000).toISOString();
		return TraceBatchAckSchema.parse(this.repository.ingest(spans, now.toISOString(), before));
	}
}