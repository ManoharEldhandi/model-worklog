import { CreateTraceCredentialSchema, TracePrincipalSchema, type TracePrincipal, type TraceRole } from 'model-worklog-schema';

import { TraceError, type CredentialRepository, type SecretCodec, type TraceAuthenticator, type TraceCredential } from '../domain/contracts';

export function requireRole(principal: TracePrincipal, roles: readonly TraceRole[]): void {
	if (!roles.includes(principal.role)) { throw new TraceError(403, 'forbidden', 'This credential is not permitted to perform this operation.'); }
}

export function requireProject(principal: TracePrincipal, projectId: string): void {
	if (!principal.projects.includes(projectId) && !(principal.role === 'admin' && principal.projects.includes('*'))) {
		throw new TraceError(403, 'project_forbidden', 'This credential does not authorize the requested project.');
	}
}

export class TraceCredentials implements TraceAuthenticator {
	private readonly adminDigest: string;

	constructor(private readonly repository: CredentialRepository, private readonly secrets: SecretCodec, adminToken: string, private readonly now: () => Date) {
		if (adminToken === '' || adminToken.length > 4_096 || /[\s\x00-\x1f\x7f]/.test(adminToken)) { throw new Error('The administrator credential is invalid.'); }
		this.adminDigest = secrets.digest(adminToken);
	}

	authenticate(token: string | undefined): TracePrincipal {
		const denied = new TraceError(401, 'unauthorized', 'A valid x-model-worklog-token credential is required.');
		if (token === undefined || token.length > 4_096 || token === '' || /[\s\x00-\x1f\x7f]/.test(token)) { throw denied; }
		const digest = this.secrets.digest(token);
		if (this.secrets.equal(this.adminDigest, digest)) { return TracePrincipalSchema.parse({ id: 'admin', role: 'admin', projects: ['*'] }); }
		const record = this.repository.find(digest);
		if (record === undefined || !this.secrets.equal(record.digest, digest) || Date.parse(record.expiresAt) <= this.now().getTime()) { throw denied; }
		return TracePrincipalSchema.parse({ id: record.id, role: record.role, projects: record.projects, expiresAt: record.expiresAt });
	}

	create(principal: TracePrincipal, input: unknown): TraceCredential {
		requireRole(principal, ['admin']);
		const parsed = CreateTraceCredentialSchema.safeParse(input);
		if (!parsed.success) { throw new TraceError(400, 'invalid_credential', 'Expected a reader or writer role, explicit projects, and a TTL between 60 and 31536000 seconds.'); }
		const projects = [...new Set(parsed.data.projects)];
		for (const projectId of projects) { requireProject(principal, projectId); }
		const token = this.secrets.issue();
		const digest = this.secrets.digest(token);
		if (this.secrets.equal(this.adminDigest, digest)) { throw new TraceError(500, 'credential_generation', 'Scoped credential generation failed.'); }
		const id = `cred_${this.secrets.issue()}`;
		const expiresAt = new Date(this.now().getTime() + parsed.data.ttlSeconds * 1_000).toISOString();
		this.repository.insert({ id, digest, role: parsed.data.role, projects, expiresAt });
		return { schemaVersion: 1, id, token, role: parsed.data.role, projects, expiresAt };
	}

	revoke(principal: TracePrincipal, id: string): void {
		requireRole(principal, ['admin']);
		if (!/^cred_[A-Za-z0-9_-]{43}$/.test(id)) { throw new TraceError(400, 'invalid_credential_id', 'Invalid credential identifier.'); }
		if (!this.repository.revoke(id)) { throw new TraceError(404, 'credential_not_found', 'Credential not found.'); }
	}
}