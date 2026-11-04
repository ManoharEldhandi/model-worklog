import { TraceError } from '../domain/contracts';
import type { LogQueryAdmission } from '../domain/logQuery';

interface QueryWindow {
	readonly expiresAt: number;
	readonly count: number;
}

export class LocalLogQueryAdmission implements LogQueryAdmission {
	private readonly windows = new Map<string, QueryWindow>();

	constructor(private readonly now: () => Date) {}

	admit(principalId: string): void {
		const now = this.now().getTime();
		for (const [key, window] of this.windows) { if (window.expiresAt <= now) { this.windows.delete(key); } }
		const existing = this.windows.get(principalId);
		if ((existing?.count ?? 0) >= 30 || (existing === undefined && this.windows.size >= 1_024)) {
			throw new TraceError(429, 'query_rate_limited', 'Log queries are limited to 30 per credential per minute; retry after this window expires.');
		}
		this.windows.set(principalId, Object.freeze({ expiresAt: existing?.expiresAt ?? now + 60_000, count: (existing?.count ?? 0) + 1 }));
	}
}
