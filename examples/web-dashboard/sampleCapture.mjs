import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createLocalModelLogger } from 'model-worklog-sdk';

export async function captureSampleReview({ endpoint, token, projectId, workspacePath, onEvent }) {
	const logger = await createLocalModelLogger({ endpoint, token, projectId, serviceName: 'inventory-sample', privacy: { mode: 'redacted-content' } });
	let traceId;
	let delivery;
	try {
		await logger.trace({ name: 'inventory.sample-review', kind: 'agent', input: { message: 'Read the inventory sample, search quantity handling, and validate negative stock.' }, serializeResult: (result) => result }, async (root) => {
			traceId = root.context.traceId;
			const contents = [];
			for (let index = 0; index < 120; index += 1) {
				const path = ['README.md', 'src/inventory.ts', 'src/pricing.ts'][index % 3];
				const correlationId = randomUUID();
				onEvent('tool.called', { tool: 'read_file', arguments: { path } }, correlationId);
				const content = await logger.trace({ name: 'read_file', kind: 'tool', attributes: { 'tool.name': 'read_file' }, input: { path }, serializeResult: (result) => result }, async () => readFile(join(workspacePath, path), 'utf8'));
				onEvent('file.read', { tool: 'read_file', path }, correlationId);
				onEvent('tool.completed', { tool: 'read_file', success: true, result: { bytes: Buffer.byteLength(content) } }, correlationId);
				if (index < 3) { contents.push(content); }
				if (index % 20 === 19) { await logger.flush(); }
			}
			await logger.trace({ name: 'search_workspace', kind: 'tool', attributes: { 'tool.name': 'search_workspace' }, input: { query: 'quantity' }, serializeResult: (result) => result }, () => contents.flatMap((content) => content.split('\n').filter((line) => line.includes('quantity'))));
			try {
				await logger.trace({ name: 'validate_stock', kind: 'tool', attributes: { 'tool.name': 'validate_stock' }, input: { quantity: -1 } }, (span) => {
					span.setAttribute('error.message', 'Stock quantity must not be negative.');
					throw new Error('Stock quantity must not be negative.');
				});
			} catch { onEvent('tool.completed', { tool: 'validate_stock', success: false, result: 'Stock quantity must not be negative.' }, randomUUID()); }
			return { summary: 'Read the inventory files 120 times, searched quantity handling once, and recorded one handled validation failure for negative stock.' };
		});
	} finally { delivery = await logger.shutdown(); }
	if (!delivery.success) { throw new Error('Sample trace delivery was incomplete.'); }
	return { traceId, delivery: delivery.success, toolCalls: 122 };
}

export async function captureRefundReview({ endpoint, token, projectId, onEvent }) {
	const logger = await createLocalModelLogger({ endpoint, token, projectId, serviceName: 'refund-sample', privacy: { mode: 'redacted-content' } });
	let traceId; let delivery;
	try {
		await logger.trace({ name: 'payment.review', kind: 'agent', input: { message: 'Investigate why a refund was rejected.' }, serializeResult: (result) => result }, async (root) => {
			traceId = root.context.traceId;
			try {
				await logger.trace({ name: 'payment.refund', kind: 'tool', input: { paymentAgeDays: 190 } }, (span) => {
					span.captureOutput({ code: 'REFUND_WINDOW_EXPIRED', message: 'The refund was rejected because the original card payment settled 190 days ago. Refunds are allowed only within 180 days.' });
					onEvent('tool.completed', { tool: 'payment.refund', success: false, result: 'Refund window expired.' }, randomUUID());
					throw new Error('Refund window expired.');
				});
			} catch { /* The application handles the recorded failure. */ }
			return { summary: 'The refund failed because the payment was 190 days old, beyond the 180-day refund window. No refund amount was captured.' };
		});
	} finally { delivery = await logger.shutdown(); }
	if (!delivery.success) { throw new Error('Sample trace delivery was incomplete.'); }
	return { traceId, delivery: true, toolCalls: 1 };
}
