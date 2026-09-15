import { randomUUID } from 'node:crypto';

import { API_VERSION, SCHEMA_VERSION, type HealthResponse } from 'model-worklog-schema';

export interface SupervisorIdentity {
	readonly supervisorVersion: string;
	readonly instanceId: string;
	readonly startedAt: string;
}

export function createIdentity(version: string, now: Date = new Date()): SupervisorIdentity {
	return {
		supervisorVersion: version,
		instanceId: `sup_${randomUUID()}`,
		startedAt: now.toISOString(),
	};
}

export interface HealthOverrides {
	readonly status?: HealthResponse['status'];
	readonly adapters?: string[];
	readonly features?: string[];
}

export function buildHealthResponse(identity: SupervisorIdentity, overrides: HealthOverrides = {}): HealthResponse {
	return {
		status: overrides.status ?? 'ok',
		supervisorVersion: identity.supervisorVersion,
		apiVersion: API_VERSION,
		schemaVersion: SCHEMA_VERSION,
		instanceId: identity.instanceId,
		startedAt: identity.startedAt,
		capabilities: {
			adapters: overrides.adapters ?? ['codex-app-server'],
			features: overrides.features ?? ['health', 'sessions', 'event-log', 'managed-process', 'workspace-trust', 'integration-ingest', 'codex-app-server-relay', 'session-cancel', 'token-budget', 'duration-budget', 'redacted-evidence-bundle', 'cost-report'],
		},
	};
}
