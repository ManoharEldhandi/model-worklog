import type { LogConversationMessage } from 'model-worklog-schema';

export type LogQueryIntent = 'tools' | 'failures' | 'search';
export type LogQueryFocus = 'overview' | 'request' | 'response' | 'files' | 'usage' | 'timeline';

export interface LogQueryPlan {
	readonly intent: LogQueryIntent;
	readonly terms: readonly string[];
	readonly focus?: LogQueryFocus;
	readonly contextual?: boolean;
}

export interface LogQueryStrategy {
	readonly intent: LogQueryIntent;
	matches(question: string): boolean;
}

const strategies: readonly LogQueryStrategy[] = Object.freeze([
	Object.freeze({ intent: 'failures' as const, matches: (question: string): boolean => /\b(fail(?:ed|ure|ures|ing)?|errors?|exceptions?|crash(?:ed|es)?)\b/i.test(question) }),
	Object.freeze({ intent: 'tools' as const, matches: (question: string): boolean => /\b(tools?|mcp)\b|\bhow many times\b|\bhow often\b|\b(?:usage|invocation) counts?\b|\bcount (?:calls|invocations)\b/i.test(question) }),
]);

const stopWords = new Set('a an and are as at be been by can did do does for from had has have here how i in is it its me of on or please show tell that the their then there these they this those to used using was were what when where which who why will with you'.split(' '));

export function conversationQuestion(question: string, history: readonly Readonly<LogConversationMessage>[]): string {
	if (!/\b(it|that|this|those|these|they|them|earlier|previous|same|also)\b|^(?:and|why|what about)\b/i.test(question)) { return question; }
	const previous = history.filter((message) => message.role === 'user').slice(-2).map((message) => message.content).join(' ');
	return previous === '' ? question : `${question}\nEarlier question: ${previous}`;
}

function queryFocus(question: string): LogQueryFocus | undefined {
	if (/\b(?:user|human)\b.*\b(?:ask|request|want)|\b(?:original|initial) (?:prompt|request)|\bwhat (?:was|is) (?:the )?(?:task|request|prompt)\b/i.test(question)) { return 'request'; }
	if (/\b(?:answer(?:ed)?|respond(?:ed|ing)?|response|repl(?:y|ied))\b|\b(?:assistant|agent|copilot)\b.*\b(?:say|said|conclude)/i.test(question)) { return 'response'; }
	if (/\b(tokens?|models?|cost|usage|credits?|spend|spent)\b/i.test(question)) { return 'usage'; }
	if (/\b(timeline|chronolog|sequence|before|after|first|last|order)\b/i.test(question)) { return 'timeline'; }
	if (/\b(files?|directories|paths?|changed|edited|modif(?:y|ied))\b/i.test(question)) { return 'files'; }
	if (/\b(summar(?:y|ize|ise)|overview|happened|explain|doing|accomplish(?:ed)?)\b/i.test(question)) { return 'overview'; }
	return undefined;
}

export function queryTerms(question: string): readonly string[] {
	const words = question.toLowerCase().match(/[\p{L}\p{N}_][\p{L}\p{N}_.:/-]*/gu) ?? [];
	return Object.freeze([...new Set(words.filter((word) => word.length > 1 && !stopWords.has(word)).map((word) => word.slice(0, 80)))].slice(0, 12));
}

export function requestedToolName(question: string): string | undefined {
	const match = /\b(?:how many times|how often)\s+(?:(?:was|is|were|has|have|did)\s+)?(?:the\s+tool\s+)?[`"']?([\p{L}\p{N}_.:/-]{1,256})[`"']?\s+(?:been\s+)?(?:used|called|invoked|run)\b/iu.exec(question);
	const name = match?.[1];
	return name === undefined || ['this', 'that', 'it', 'tools', 'tool'].includes(name.toLowerCase()) ? undefined : name;
}

export function planLogQuery(question: string, candidates: readonly LogQueryStrategy[] = strategies): LogQueryPlan {
	const focus = queryFocus(question.split('\n')[0] ?? question);
	const selected = candidates.find((strategy) => strategy.matches(question))?.intent ?? 'search';
	const intent = selected === 'tools' && focus !== undefined && !/\b(?:how many times|how often|tool calls|invocation counts?)\b/i.test(question) ? 'search' : selected;
	return Object.freeze({ intent, terms: queryTerms(question), ...(focus === undefined ? {} : { focus }) });
}
