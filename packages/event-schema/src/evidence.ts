/** Provenance is explicit: integrations cannot claim stronger observation. */
export const EVIDENCE_GRADES = [
	'observed-native',
	'observed-boundary',
	'computed',
	'model-declared',
	'unknown',
] as const;

export type EvidenceGrade = (typeof EVIDENCE_GRADES)[number];

export const UNKNOWN_REASONS = [
	'not-observed',
	'unsupported-capability',
	'ambiguous',
	'adapter-error',
	'redacted',
	'truncated',
	'malformed',
	'timeout',
] as const;

export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

export function isEvidenceGrade(value: unknown): value is EvidenceGrade {
	return typeof value === 'string' && (EVIDENCE_GRADES as readonly string[]).includes(value);
}

export function isUnknownReason(value: unknown): value is UnknownReason {
	return typeof value === 'string' && (UNKNOWN_REASONS as readonly string[]).includes(value);
}
