import {
	LogQueryResponseSchema, LogSynthesisResultSchema, redactSensitiveText, type LogConversationMessage, type LogQueryRequest, type LogQueryResponse, type LogQueryScope,
} from 'model-worklog-schema';

import { composeLogAnswer, logQueryLimitations } from '../domain/logAnswer';
import type { LogAnswerGenerator, LogQueryAdmission, LogQueryRepository } from '../domain/logQuery';
import { conversationQuestion, planLogQuery, requestedToolName } from '../domain/queryPlanner';

function queryScope(request: Readonly<LogQueryRequest>): Readonly<LogQueryScope> {
	return Object.freeze({
		projectId: request.projectId,
		...(request.traceId === undefined ? {} : { traceId: request.traceId }),
		...(request.toolName === undefined ? {} : { toolName: redactSensitiveText(request.toolName) }),
		...(request.since === undefined ? {} : { since: new Date(request.since).toISOString() }),
		...(request.until === undefined ? {} : { until: new Date(request.until).toISOString() }),
	});
}

function mentionedTool(question: string, names: readonly string[]): string | undefined {
	const normalized = question.toLowerCase();
	const matches = names.filter((name) => {
		const candidate = name.toLowerCase();
		const offset = normalized.indexOf(candidate);
		if (offset < 0) { return false; }
		const before = normalized[offset - 1];
		const after = normalized[offset + candidate.length];
		return (before === undefined || !/[\p{L}\p{N}_.:/-]/u.test(before)) && (after === undefined || !/[\p{L}\p{N}_.:/-]/u.test(after));
	});
	return matches.length === 1 ? matches[0] : undefined;
}

async function generateWithinDeadline(generator: LogAnswerGenerator, question: string, evidence: LogQueryResponse, signal: AbortSignal, history: readonly Readonly<LogConversationMessage>[]): ReturnType<LogAnswerGenerator['generate']> {
	let cancel: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		cancel = (): void => reject(signal.reason);
		signal.addEventListener('abort', cancel, { once: true });
		if (signal.aborted) { cancel(); }
	});
	try { return await Promise.race([generator.generate(question, evidence, signal, history), aborted]); }
	finally { if (cancel !== undefined) { signal.removeEventListener('abort', cancel); } }
}

export class LogQueryService {
	constructor(private readonly repository: LogQueryRepository, private readonly admission: LogQueryAdmission, private readonly now: () => Date, private readonly generator?: LogAnswerGenerator) {}

	async askWithSynthesis(principalId: string, request: Readonly<LogQueryRequest>, cancellation?: AbortSignal): Promise<LogQueryResponse> {
		const local = this.ask(principalId, request);
		if (request.synthesis !== 'model') { return local; }
		try {
			if (this.generator === undefined) { throw new Error('No answer provider is configured.'); }
			const signal = AbortSignal.any([AbortSignal.timeout(45_000), ...(cancellation === undefined ? [] : [cancellation])]);
			signal.throwIfAborted();
			const history = Object.freeze(request.history.map((message) => Object.freeze({ ...message, content: redactSensitiveText(message.content) })));
			const generated = LogSynthesisResultSchema.parse(await generateWithinDeadline(this.generator, redactSensitiveText(request.question), local, signal, history));
			const available = new Set(['A1', ...local.evidence.map((source) => source.id)]);
			const cited = [...generated.answer.matchAll(/\[((?:S[1-9][0-9]*|A1))\]/g)].map((match) => match[1]!);
			if ((cited.length === 0 && local.totals.spans > 0) || cited.some((id) => !available.has(id) || !generated.sourceIds.includes(id))
				|| generated.sourceIds.some((id) => !available.has(id) || !cited.includes(id))) { throw new Error('The generated answer has invalid citations.'); }
			return LogQueryResponseSchema.parse({ ...local, answer: redactSensitiveText(generated.answer),
				generation: { mode: 'model', status: 'generated', provider: this.generator.provider, model: this.generator.model }, limitations: [...local.limitations, 'AI answers can be incorrect. Citations identify current evidence; they do not independently verify every interpretation.'] });
		} catch {
			cancellation?.throwIfAborted();
			return LogQueryResponseSchema.parse({ ...local, generation: { mode: 'extractive', status: 'fallback' },
				limitations: [...local.limitations, 'The AI answer was unavailable, timed out, or had invalid citations. This is a local evidence-only fallback, not a generated conversation reply.'] });
		}
	}

	ask(principalId: string, request: Readonly<LogQueryRequest>): LogQueryResponse {
		this.admission.admit(principalId);
		const automatic = planLogQuery(request.question);
		const resolved = conversationQuestion(request.question, request.history);
		const plan = Object.freeze({ ...automatic, terms: planLogQuery(resolved).terms, intent: request.intent === 'auto' ? automatic.intent : request.intent, contextual: request.synthesis === 'model' });
		let scope = queryScope(request);
		let snapshot = this.repository.retrieve(scope, plan, request.limit);
		if (plan.intent === 'tools' && scope.toolName === undefined) {
			const name = requestedToolName(request.question) ?? mentionedTool(resolved, snapshot.tools.map((tool) => tool.name));
			if (name !== undefined) {
				scope = Object.freeze({ ...scope, toolName: name });
				snapshot = this.repository.retrieve(scope, plan, request.limit);
			}
		}
		return LogQueryResponseSchema.parse({
			schemaVersion: 1, intent: plan.intent, question: redactSensitiveText(request.question), answer: composeLogAnswer(scope, plan, snapshot), scope,
			snapshotAt: this.now().toISOString(), totals: snapshot.totals, overview: snapshot.overview, tools: snapshot.tools, evidence: snapshot.evidence,
			retrieval: { strategy: snapshot.strategy, matchedSpans: snapshot.matchedSpans, returnedSpans: snapshot.evidence.length,
				truncated: (snapshot.contextExpanded === true ? snapshot.totals.spans : snapshot.matchedSpans) > snapshot.evidence.length, toolsTruncated: snapshot.toolsTruncated, contextExpanded: snapshot.contextExpanded ?? false },
			limitations: logQueryLimitations(snapshot),
		});
	}
}
