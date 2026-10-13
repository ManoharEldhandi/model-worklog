import type {
	CreateTraceCredentialSchema, StoredTraceSpan, TraceBatchAck, TracePrincipal, TraceSpan, TraceSummary,
} from 'model-worklog-schema';

export class TraceError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
		this.name = 'TraceError';
	}
}

export interface PreparedSpan {
	readonly span: TraceSpan;
	readonly contentHash: string;
	readonly identityHash: string;
	readonly usageKey?: string;
}

export type SummarySpan = Pick<TraceSpan, 'spanId' | 'parentSpanId' | 'name' | 'serviceName' | 'kind' | 'startedAt' | 'state' | 'usage' | 'capture'> & { readonly usageKey?: string };

export interface TracePage<Item> {
	readonly items: Item[];
	readonly after?: number;
}

export interface CleanupResult {
	readonly deleted: number;
	readonly hasMore: boolean;
}

export interface TraceRepository {
	ingest(spans: readonly PreparedSpan[], receivedAt: string, retentionBefore?: string): TraceBatchAck;
	list(projectId: string, limit: number, after?: number): TracePage<TraceSummary>;
	detail(projectId: string, traceId: string, limit: number, after?: number): TracePage<StoredTraceSpan>;
	delete(projectId: string, traceId: string): boolean;
	cleanup(projectId: string, before: string, limit: number): CleanupResult;
}

export type CreateTraceCredential = ReturnType<typeof CreateTraceCredentialSchema.parse>;

export interface TraceCredential {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly token: string;
	readonly role: 'writer' | 'reader';
	readonly projects: string[];
	readonly expiresAt: string;
}

export interface CredentialRecord {
	readonly id: string;
	readonly digest: string;
	readonly role: 'writer' | 'reader';
	readonly projects: string[];
	readonly expiresAt: string;
}

export interface CredentialRepository {
	find(digest: string): CredentialRecord | undefined;
	insert(record: CredentialRecord): void;
	revoke(id: string): boolean;
}

export interface SecretCodec {
	issue(): string;
	digest(value: string): string;
	equal(left: string, right: string): boolean;
}

export interface TraceAuthenticator {
	authenticate(token: string | undefined): TracePrincipal;
}

export interface CursorScope {
	readonly projectId: string;
	readonly traceId?: string;
}

export interface CursorCodec {
	encode(after: number, scope: CursorScope): string;
	decode(cursor: string, scope: CursorScope): number;
}

export interface TraceStorageOptions {
	readonly maxStoredSpans?: number;
	readonly maxStoredBytes?: number;
	readonly maxSpansPerTrace?: number;
	readonly retentionTtlSeconds?: number;
}

export interface TraceStorageLimits {
	readonly maxStoredSpans: number;
	readonly maxStoredBytes: number;
	readonly maxSpansPerTrace: number;
	readonly retentionTtlSeconds?: number;
}