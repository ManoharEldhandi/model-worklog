import { LogSynthesisResultSchema, type LogConversationMessage, type LogQueryResponse, type LogSynthesisResult } from 'model-worklog-schema';

import type { LogAnswerGenerator } from '../domain/logQuery';
import { LOG_ANSWER_INSTRUCTIONS, logAnswerContext } from '../domain/logPrompt';

export interface OpenAiLogAnswerOptions {
	readonly endpoint: string;
	readonly model: string;
	readonly apiKey?: string;
}

async function boundedJson(response: Response): Promise<unknown> {
	const length = response.headers.get('content-length');
	if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 65_536)) { await response.body?.cancel(); throw new Error('The answer provider response exceeded the safety limit.'); }
	const reader = response.body?.getReader();
	if (reader === undefined) { throw new Error('The answer provider returned an empty response.'); }
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) { break; }
			bytes += chunk.value.byteLength;
			if (bytes > 65_536) { throw new Error('The answer provider response exceeded the safety limit.'); }
			chunks.push(chunk.value);
		}
		return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown;
	} finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export class OpenAiLogAnswerGenerator implements LogAnswerGenerator {
	readonly provider = 'openai-compatible';
	readonly model: string;
	private readonly endpoint: string;
	private readonly options: Readonly<OpenAiLogAnswerOptions>;
	private active = 0;

	constructor(options: OpenAiLogAnswerOptions) {
		const endpoint = new URL(options.endpoint);
		if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash
			|| (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname)))) {
			throw new Error('The log answer provider requires HTTPS or loopback HTTP without URL credentials or query parameters.');
		}
		if (options.model.trim() === '' || options.model.length > 128 || /[\r\n]/.test(options.apiKey ?? '')) { throw new Error('Invalid log answer provider configuration.'); }
		this.endpoint = endpoint.href;
		this.model = options.model;
		this.options = Object.freeze({ ...options });
	}

	async generate(question: string, evidence: Readonly<LogQueryResponse>, signal: AbortSignal, history: readonly Readonly<LogConversationMessage>[] = []): Promise<LogSynthesisResult> {
		if (this.active >= 2) { throw new Error('The answer provider is busy.'); }
		this.active += 1;
		try {
			const response = await fetch(this.endpoint, {
				method: 'POST', redirect: 'error', cache: 'no-store', signal,
				headers: { 'content-type': 'application/json', ...(this.options.apiKey === undefined ? {} : { authorization: `Bearer ${this.options.apiKey}` }) },
				body: JSON.stringify({
					model: this.options.model, stream: false, max_tokens: 1_500,
					messages: [
						{ role: 'system', content: LOG_ANSWER_INSTRUCTIONS },
						{ role: 'user', content: logAnswerContext(question, evidence, history) },
					],
				}),
			});
			if (!response.ok) { await response.body?.cancel(); throw new Error('The answer provider did not return a successful response.'); }
			const payload = await boundedJson(response);
			const content = (payload as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
			if (typeof content !== 'string') { throw new Error('The answer provider returned invalid content.'); }
			return LogSynthesisResultSchema.parse(JSON.parse(content) as unknown);
		} finally { this.active -= 1; }
	}
}
