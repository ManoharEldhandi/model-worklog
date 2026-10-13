import { TracePrincipalSchema } from 'model-worklog-schema';

import { TraceError, type CredentialRecord, type CredentialRepository } from '../domain/contracts';
import { TraceDatabase, integer, text } from './database';

export class SqliteCredentialRepository implements CredentialRepository {
	constructor(private readonly database: TraceDatabase, private readonly now: () => Date) {}

	find(digest: string): CredentialRecord | undefined {
		return this.database.transaction(false, () => {
			const row = this.database.statement('SELECT id, digest, role, projects, expires_at FROM credentials WHERE digest = ? AND revoked = 0').get(digest);
			if (row === undefined) { return undefined; }
			const principal = TracePrincipalSchema.parse({ id: text(row, 'id'), role: text(row, 'role'), projects: JSON.parse(text(row, 'projects')) as unknown, expiresAt: text(row, 'expires_at') });
			if (principal.role === 'admin' || principal.projects.includes('*') || principal.expiresAt === undefined) { throw new Error('Invalid stored credential scope.'); }
			return { ...principal, role: principal.role, expiresAt: principal.expiresAt, digest: text(row, 'digest') };
		});
	}

	insert(record: CredentialRecord): void {
		this.database.transaction(true, () => {
			this.database.statement('DELETE FROM credentials WHERE id IN (SELECT id FROM credentials WHERE revoked = 1 OR expires_at <= ? LIMIT 100)').run(this.now().toISOString());
			const count = this.database.statement('SELECT COUNT(*) AS count FROM credentials').get();
			if (integer(count, 'count') >= 10_000) { throw new TraceError(429, 'credential_quota', 'Credential capacity reached; revoke unused credentials.'); }
			this.database.statement('INSERT INTO credentials(id, digest, role, projects, expires_at) VALUES (?, ?, ?, ?, ?)').run(record.id, record.digest, record.role, JSON.stringify(record.projects), record.expiresAt);
		});
	}

	revoke(id: string): boolean {
		return this.database.transaction(true, () => this.database.statement('UPDATE credentials SET revoked = 1 WHERE id = ?').run(id).changes !== 0);
	}
}