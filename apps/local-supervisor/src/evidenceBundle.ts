import { createHash } from 'node:crypto';

import type { JsonObject, JsonValue, SessionEvent, SessionRecord } from 'model-worklog-schema';

import { calculateCostReport, type CostReport } from './pricing';
import { REDACTION_POLICY_VERSION, redactJson } from './redaction';
import { SUPERVISOR_VERSION } from './version';

export const EVIDENCE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_BUNDLE_KIND = 'model-worklog-evidence-bundle' as const;

const SECTION_NAMES = ['session', 'events', 'workspaceDiffs', 'cost'] as const;
type SectionName = typeof SECTION_NAMES[number];

export interface EvidenceBundleManifest {
	readonly algorithm: 'sha256';
	readonly canonicalization: 'utf8-json-sorted-keys-v1';
	readonly contentSha256: string;
	readonly sections: Readonly<Record<SectionName, string>>;
}

export interface EvidenceBundle {
	readonly schemaVersion: typeof EVIDENCE_BUNDLE_SCHEMA_VERSION;
	readonly kind: typeof EVIDENCE_BUNDLE_KIND;
	readonly generatedAt: string;
	readonly supervisor: { readonly version: string; readonly redactionPolicyVersion: string };
	readonly exportRedaction: { readonly pathReplacements: number; readonly secretReplacements: number };
	readonly session: SessionRecord;
	readonly events: readonly SessionEvent[];
	readonly workspaceDiffs: readonly SessionEvent[];
	readonly cost: CostReport;
	readonly manifest: EvidenceBundleManifest;
}

export interface BundleVerification {
	readonly schemaVersion: 1;
	readonly valid: boolean;
	readonly reason?: 'malformed' | 'content-hash-mismatch' | 'section-hash-mismatch';
}

interface ScrubResult {
	readonly value: JsonValue;
	readonly pathReplacements: number;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function canonicalJson(value: JsonValue): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key]!)}`).join(',')}}`;
}

function sha256(value: JsonValue): string {
	return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function scrubAbsolutePathText(value: string): { readonly value: string; readonly replacements: number } {
	let replacements = 0;
	const replace = (input: string, expression: RegExp): string => input.replace(expression, (_match: string, prefix: string) => {
		replacements += 1;
		return `${prefix}[PATH REDACTED]`;
	});
	let scrubbed = value.replace(/file:\/\/[^\s"']+/g, () => {
		replacements += 1;
		return '[PATH REDACTED]';
	});
	scrubbed = replace(scrubbed, /(^|[\s="'(:])\/(?!v\d+(?:\/|$))(?:[^\s/"']+\/)*[^\s/"']+/g);
	scrubbed = replace(scrubbed, /(^|[\s="'(:])[A-Za-z]:\\(?:[^\s\\"']+\\)*[^\s\\"']+/g);
	return { value: scrubbed, replacements };
}

function scrubAbsolutePaths(value: JsonValue): ScrubResult {
	if (typeof value === 'string') {
		const scrubbed = scrubAbsolutePathText(value);
		return { value: scrubbed.value, pathReplacements: scrubbed.replacements };
	}
	if (value === null || typeof value === 'boolean' || typeof value === 'number') {
		return { value, pathReplacements: 0 };
	}
	if (Array.isArray(value)) {
		let pathReplacements = 0;
		const entries = value.map((entry) => {
			const scrubbed = scrubAbsolutePaths(entry);
			pathReplacements += scrubbed.pathReplacements;
			return scrubbed.value;
		});
		return { value: entries, pathReplacements };
	}
	let pathReplacements = 0;
	const entries: Record<string, JsonValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		const scrubbed = scrubAbsolutePaths(entry);
		pathReplacements += scrubbed.pathReplacements;
		entries[key] = scrubbed.value;
	}
	return { value: entries, pathReplacements };
}

function sectionHashes(content: Record<string, JsonValue>): Readonly<Record<SectionName, string>> {
	return Object.fromEntries(SECTION_NAMES.map((name) => [name, sha256(content[name]!)])) as Readonly<Record<SectionName, string>>;
}

export function createEvidenceBundle(session: SessionRecord, events: readonly SessionEvent[], generatedAt: string): EvidenceBundle {
	const orderedEvents = [...events].sort((left, right) => left.sequence - right.sequence);
	const rawContent: JsonObject = {
		schemaVersion: EVIDENCE_BUNDLE_SCHEMA_VERSION,
		kind: EVIDENCE_BUNDLE_KIND,
		generatedAt,
		supervisor: { version: SUPERVISOR_VERSION, redactionPolicyVersion: REDACTION_POLICY_VERSION },
		session: session as unknown as JsonObject,
		events: orderedEvents as unknown as JsonValue,
		workspaceDiffs: orderedEvents.filter((event) => event.kind === 'workspace.diff') as unknown as JsonValue,
		cost: calculateCostReport(orderedEvents) as unknown as JsonObject,
	};
	const scrubbed = scrubAbsolutePaths(rawContent);
	const redacted = redactJson(scrubbed.value);
	const content = {
		...(redacted.value as JsonObject),
		exportRedaction: { pathReplacements: scrubbed.pathReplacements, secretReplacements: redacted.replacements },
	};
	const manifest: EvidenceBundleManifest = {
		algorithm: 'sha256',
		canonicalization: 'utf8-json-sorted-keys-v1',
		contentSha256: sha256(content),
		sections: sectionHashes(content),
	};
	return { ...(content as unknown as Omit<EvidenceBundle, 'manifest'>), manifest };
}

export function verifyEvidenceBundle(value: unknown): BundleVerification {
	const bundle = asObject(value);
	const manifest = asObject(bundle?.manifest);
	const hashes = asObject(manifest?.sections);
	if (bundle === undefined || manifest === undefined || hashes === undefined
		|| bundle.schemaVersion !== EVIDENCE_BUNDLE_SCHEMA_VERSION || bundle.kind !== EVIDENCE_BUNDLE_KIND
		|| manifest.algorithm !== 'sha256' || manifest.canonicalization !== 'utf8-json-sorted-keys-v1'
		|| typeof manifest.contentSha256 !== 'string' || !SECTION_NAMES.every((name) => typeof hashes[name] === 'string')) {
		return { schemaVersion: 1, valid: false, reason: 'malformed' };
	}
	const content = Object.fromEntries(Object.entries(bundle).filter(([key]) => key !== 'manifest')) as JsonObject;
	if (sha256(content) !== manifest.contentSha256) {
		return { schemaVersion: 1, valid: false, reason: 'content-hash-mismatch' };
	}
	for (const name of SECTION_NAMES) {
		if (sha256(content[name]!) !== hashes[name]) {
			return { schemaVersion: 1, valid: false, reason: 'section-hash-mismatch' };
		}
	}
	return { schemaVersion: 1, valid: true };
}