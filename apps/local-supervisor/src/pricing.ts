import type { SessionEvent } from 'model-worklog-schema';

export const PRICE_TABLE_VERSION = 'builtin-2026-09-15' as const;
export const NANO_USD_PER_USD = 1_000_000_000n;

interface ModelPrice {
	readonly provider: string;
	readonly model: string;
	readonly inputNanoUsd: number;
	readonly outputNanoUsd: number;
	readonly cacheReadNanoUsd?: number;
	readonly cacheWriteNanoUsd?: number;
	readonly inputIncludesCacheRead: boolean;
}

const PRICE_TABLE: readonly ModelPrice[] = [
	{ provider: 'openai', model: 'gpt-5.6-terra', inputNanoUsd: 2_000, outputNanoUsd: 12_000, cacheReadNanoUsd: 200, inputIncludesCacheRead: true },
	{ provider: 'anthropic', model: 'claude-sonnet-5', inputNanoUsd: 2_000, outputNanoUsd: 10_000, cacheReadNanoUsd: 200, cacheWriteNanoUsd: 2_500, inputIncludesCacheRead: false },
	{ provider: 'gemini', model: 'gemini-2.5-flash', inputNanoUsd: 300, outputNanoUsd: 2_500, cacheReadNanoUsd: 30, inputIncludesCacheRead: true },
];

export interface CostLineItem {
	readonly sequence: number;
	readonly provider?: string;
	readonly model?: string;
	readonly status: 'priced' | 'unknown';
	readonly totalNanoUsd?: string;
	readonly totalUsd?: string;
	readonly reason?: string;
}

export interface CostReport {
	readonly schemaVersion: 1;
	readonly tableVersion: typeof PRICE_TABLE_VERSION;
	readonly currency: 'USD';
	readonly status: 'reported' | 'partial' | 'unknown';
	readonly totalNanoUsd: string;
	readonly totalUsd: string;
	readonly lineItems: readonly CostLineItem[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function dollars(value: bigint): string {
	const whole = value / NANO_USD_PER_USD;
	const fraction = (value % NANO_USD_PER_USD).toString().padStart(9, '0').replace(/0+$/, '');
	return fraction === '' ? whole.toString() : `${whole}.${fraction}`;
}

function unknownLine(event: SessionEvent, provider: string | undefined, model: string | undefined, reason: string): CostLineItem {
	return { sequence: event.sequence, ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }), status: 'unknown', reason };
}

function priceUsage(event: SessionEvent): CostLineItem {
	const payload = asRecord(event.payload);
	const provider = typeof payload?.provider === 'string' && payload.provider.trim() !== '' ? payload.provider : undefined;
	const model = typeof payload?.model === 'string' && payload.model.trim() !== '' ? payload.model : undefined;
	if (provider === undefined || model === undefined) {
		return unknownLine(event, provider, model, 'Provider and model are required for cost calculation.');
	}
	const price = PRICE_TABLE.find((entry) => entry.provider === provider && entry.model === model);
	if (price === undefined) {
		return unknownLine(event, provider, model, `No ${PRICE_TABLE_VERSION} rate is available for ${provider}/${model}.`);
	}
	const inputTokens = count(payload?.inputTokens);
	const outputTokens = count(payload?.outputTokens);
	const cacheReadTokens = count(payload?.cacheReadTokens) ?? 0;
	const cacheWriteTokens = count(payload?.cacheWriteTokens) ?? 0;
	if (inputTokens === undefined || outputTokens === undefined) {
		return unknownLine(event, provider, model, 'Input and output token counts are required for cost calculation.');
	}
	if (price.inputIncludesCacheRead && cacheReadTokens > inputTokens) {
		return unknownLine(event, provider, model, 'Cache-read tokens cannot exceed input tokens for this provider.');
	}
	if (cacheReadTokens > 0 && price.cacheReadNanoUsd === undefined) {
		return unknownLine(event, provider, model, 'The price table has no cache-read rate for this provider/model.');
	}
	if (cacheWriteTokens > 0 && price.cacheWriteNanoUsd === undefined) {
		return unknownLine(event, provider, model, 'The price table has no cache-write rate for this provider/model.');
	}
	const billableInput = price.inputIncludesCacheRead ? inputTokens - cacheReadTokens : inputTokens;
	const total = BigInt(billableInput) * BigInt(price.inputNanoUsd)
		+ BigInt(outputTokens) * BigInt(price.outputNanoUsd)
		+ BigInt(cacheReadTokens) * BigInt(price.cacheReadNanoUsd ?? 0)
		+ BigInt(cacheWriteTokens) * BigInt(price.cacheWriteNanoUsd ?? 0);
	return { sequence: event.sequence, provider, model, status: 'priced', totalNanoUsd: total.toString(), totalUsd: dollars(total) };
}

export function calculateCostReport(events: readonly SessionEvent[]): CostReport {
	const usageEvents = events.filter((event) => event.kind === 'usage.reported');
	const lineItems = usageEvents.map(priceUsage);
	const total = lineItems.reduce((sum, item) => sum + BigInt(item.totalNanoUsd ?? '0'), 0n);
	const pricedCount = lineItems.filter((item) => item.status === 'priced').length;
	return {
		schemaVersion: 1,
		tableVersion: PRICE_TABLE_VERSION,
		currency: 'USD',
		status: pricedCount === 0 ? 'unknown' : pricedCount === lineItems.length ? 'reported' : 'partial',
		totalNanoUsd: total.toString(),
		totalUsd: dollars(total),
		lineItems,
	};
}