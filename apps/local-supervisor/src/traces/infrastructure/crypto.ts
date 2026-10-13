import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { TraceError, type CursorCodec, type CursorScope, type SecretCodec } from '../domain/contracts';

export class CryptoSecrets implements SecretCodec {
	issue(): string { return randomBytes(32).toString('base64url'); }
	digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
	equal(left: string, right: string): boolean {
		const expected = Buffer.from(left);
		const actual = Buffer.from(right);
		return expected.length === actual.length && timingSafeEqual(expected, actual);
	}
}

export class SignedTraceCursors implements CursorCodec {
	constructor(private readonly secret: string) {}

	encode(after: number, scope: CursorScope): string {
		const payload = Buffer.from(JSON.stringify([1, scope.projectId, scope.traceId ?? null, after])).toString('base64url');
		return `${payload}.${this.sign(payload)}`;
	}

	decode(cursor: string, scope: CursorScope): number {
		try {
			if (cursor.length > 1_024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor)) { throw new Error(); }
			const [payload, signature] = cursor.split('.');
			if (payload === undefined || signature === undefined || !new CryptoSecrets().equal(this.sign(payload), signature)) { throw new Error(); }
			const decoded = Buffer.from(payload, 'base64url');
			if (decoded.toString('base64url') !== payload) { throw new Error(); }
			const value: unknown = JSON.parse(decoded.toString('utf8'));
			if (!Array.isArray(value) || value.length !== 4 || value[0] !== 1 || value[1] !== scope.projectId
				|| value[2] !== (scope.traceId ?? null) || typeof value[3] !== 'number' || !Number.isSafeInteger(value[3]) || value[3] < 1) { throw new Error(); }
			return value[3];
		} catch { throw new TraceError(400, 'invalid_cursor', 'The cursor is invalid or belongs to another query.'); }
	}

	private sign(payload: string): string { return createHmac('sha256', this.secret).update(`trace-cursor:${payload}`).digest('base64url'); }
}