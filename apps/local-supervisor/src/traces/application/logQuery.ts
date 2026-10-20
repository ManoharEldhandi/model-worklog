import {
	LogQueryResponseSchema, LogSynthesisResultSchema, redactSensitiveText, type LogQueryRequest, type LogQueryResponse, type LogQueryScope,
} from 'model-worklog-schema';

import { composeLogAnswer, logQueryLimitations } from '../domain/logAnswer';
import type { LogAnswerGenerator, LogQueryAdmission, LogQueryRepository } from '../domain/logQuery';
import { planLogQuery, requestedToolName } from '../domain/queryPlanner';

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

async function generateWithinDeadline(generator: LogAnswerGenerator, question: string, evidence: LogQueryResponse, signal: AbortSignal): ReturnType<LogAnswerGenerator['generate']> {
	let cancel: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		cancel = (): void => reject(signal.reason);
		signal.addEventListener('abort', cancel, { once: true });
		if (signal.aborted) { cancel(); }
	});
	try { return await Promise.race([generator.generate(question, evidence, signal), aborted]); }
	finally { if (cancel !== undefined) { signal.removeEventListener('abort', cancel); } }
}

export class LogQueryService {
	constructor(private readonly repository: LogQueryRepository, private readonly admission: LogQueryAdmission, private readonly now: () => Date, private readonly generator?: LogAnswerGenerator) {}

	async askWithSynthesis(principalId: string, request: Readonly<LogQueryRequest>, cancellation?: AbortSignal): Promise<LogQueryResponse> {
		const local = this.ask(principalId, request);
		if (request.synthesis !== 'model' || local.intent === 'tools' || local.evidence.length === 0) { return local; }
		try {
			if (this.generator === undefined) { throw new Error('No answer provider is configured.'); }
			const signal = AbortSignal.any([AbortSignal.timeout(8_000), ...(cancellation === undefined ? [] : [cancellation])]);
			signal.throwIfAborted();
			const generated = LogSynthesisResultSchema.parse(await generateWithinDeadline(this.generator, redactSensitiveText(request.question), local, signal));
			const available = new Set(local.evidence.map((source) => source.id));
			const cited = [...generated.answer.matchAll(/\[(S[1-9][0-9]*)\]/g)].map((match) => match[1]!);
			if (cited.length === 0 || cited.some((id) => !available.has(id) || !generated.sourceIds.includes(id))
				|| generated.sourceIds.some((id) => !available.has(id) || !cited.includes(id))) { throw new Error('The generated answer has invalid citations.'); }
			return LogQueryResponseSchema.parse({ ...local, answer: `Model interpretation; verify against the cited records.\n\n${redactSensitiveText(generated.answer)}`,
				generation: { mode: 'model', status: 'generated' }, limitations: [...local.limitations, 'Model-generated interpretations can be incorrect. Citation validation checks source identities, not whether every claim is supported.'] });
		} catch {
			cancellation?.throwIfAborted();
			return LogQueryResponseSchema.parse({ ...local, generation: { mode: 'extractive', status: 'fallback' },
				limitations: [...local.limitations, 'Model synthesis was unavailable, timed out, or returned invalid citations. The local evidence answer is shown instead.'] });
		}
	}

	ask(principalId: string, request: Readonly<LogQueryRequest>): LogQueryResponse {
		this.admission.admit(principalId);
		const automatic = planLogQuery(request.question);
		const plan = request.intent === 'auto' ? automatic : Object.freeze({ ...automatic, intent: request.intent });
		let scope = queryScope(request);
		let snapshot = this.repository.retrieve(scope, plan, request.limit);
		if (plan.intent === 'tools' && scope.toolName === undefined) {
			const name = requestedToolName(request.question) ?? mentionedTool(request.question, snapshot.tools.map((tool) => tool.name));
			if (name !== undefined) {
				scope = Object.freeze({ ...scope, toolName: name });
				snapshot = this.repository.retrieve(scope, plan, request.limit);
			}
		}
		return LogQueryResponseSchema.parse({
			schemaVersion: 1, intent: plan.intent, answer: composeLogAnswer(scope, plan, snapshot), scope,
			snapshotAt: this.now().toISOString(), totals: snapshot.totals, tools: snapshot.tools, evidence: snapshot.evidence,
			retrieval: { strategy: snapshot.strategy, matchedSpans: snapshot.matchedSpans, returnedSpans: snapshot.evidence.length,
				truncated: snapshot.matchedSpans > snapshot.evidence.length, toolsTruncated: snapshot.toolsTruncated },
			limitations: logQueryLimitations(snapshot),
		});
	}
}
