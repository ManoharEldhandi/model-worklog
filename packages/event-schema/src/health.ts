/** Supervisor bootstrap health response. */

import {
	collectIssues,
	describe,
	err,
	errs,
	isRecord,
	ok,
	requireEnum,
	requireInteger,
	requireNonEmptyString,
	requireRecord,
	requireStringArray,
	type ParseIssue,
	type ParseResult,
} from './validation';
import { SUPPORTED_API_MAJOR } from './version';

export const HEALTH_STATUSES = ['ok', 'degraded'] as const;
export type HealthStatus = (typeof HEALTH_STATUSES)[number];

export interface SupervisorCapabilities {
	readonly adapters: string[];
	readonly features: string[];
}

export interface HealthResponse {
	readonly status: HealthStatus;
	readonly supervisorVersion: string;
	readonly apiVersion: string;
	readonly schemaVersion: number;
	readonly instanceId: string;
	readonly startedAt: string;
	readonly capabilities: SupervisorCapabilities;
}

const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export function isRfc3339(value: string): boolean {
	return RFC3339.test(value) && !Number.isNaN(Date.parse(value));
}

/** Returns the API major version, or null when the string is not MAJOR.MINOR. */
export function parseApiMajor(apiVersion: string): number | null {
	const match = /^(\d+)\.(\d+)$/.exec(apiVersion);
	if (match === null || match[1] === undefined) {
		return null;
	}
	return Number.parseInt(match[1], 10);
}

export function isApiCompatible(apiVersion: string): boolean {
	return parseApiMajor(apiVersion) === SUPPORTED_API_MAJOR;
}

export function parseHealthResponse(input: unknown): ParseResult<HealthResponse> {
	if (!isRecord(input)) {
		return err('', `expected object, received ${describe(input)}`);
	}

	const issues: ParseIssue[] = [];
	const status = requireEnum(input, 'status', '', HEALTH_STATUSES);
	const supervisorVersion = requireNonEmptyString(input, 'supervisorVersion', '');
	const apiVersion = requireNonEmptyString(input, 'apiVersion', '');
	const schemaVersion = requireInteger(input, 'schemaVersion', '');
	const instanceId = requireNonEmptyString(input, 'instanceId', '');
	const startedAt = requireNonEmptyString(input, 'startedAt', '');
	const capabilitiesRecord = requireRecord(input, 'capabilities', '');
	collectIssues(issues, status, supervisorVersion, apiVersion, schemaVersion, instanceId, startedAt, capabilitiesRecord);

	let capabilities: SupervisorCapabilities | undefined;
	if (capabilitiesRecord.ok) {
		const adapters = requireStringArray(capabilitiesRecord.value, 'adapters', 'capabilities');
		const features = requireStringArray(capabilitiesRecord.value, 'features', 'capabilities');
		collectIssues(issues, adapters, features);
		if (adapters.ok && features.ok) {
			capabilities = { adapters: adapters.value, features: features.value };
		}
	}

	if (startedAt.ok && !isRfc3339(startedAt.value)) {
		issues.push({ path: 'startedAt', message: 'expected RFC3339 UTC timestamp' });
	}
	if (schemaVersion.ok && schemaVersion.value < 1) {
		issues.push({ path: 'schemaVersion', message: 'expected integer >= 1' });
	}
	if (apiVersion.ok && parseApiMajor(apiVersion.value) === null) {
		issues.push({ path: 'apiVersion', message: 'expected MAJOR.MINOR version' });
	}

	if (issues.length > 0) {
		return errs(issues);
	}
	if (!status.ok || !supervisorVersion.ok || !apiVersion.ok || !schemaVersion.ok || !instanceId.ok || !startedAt.ok || capabilities === undefined) {
		return err('', 'internal: unexpected missing health field');
	}

	return ok({
		status: status.value,
		supervisorVersion: supervisorVersion.value,
		apiVersion: apiVersion.value,
		schemaVersion: schemaVersion.value,
		instanceId: instanceId.value,
		startedAt: startedAt.value,
		capabilities,
	});
}
