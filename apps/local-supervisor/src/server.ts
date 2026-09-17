import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { HealthResponse } from 'model-worklog-schema';

import { buildHealthResponse, createIdentity } from './health';
import { route } from './router';
import { SupervisorService } from './service';
import type { CodexRelayFactory } from './codexRelay';
import type { CopilotRelayFactory } from './copilotRelay';
import { defaultDataDirectory } from './state';
import { SUPERVISOR_VERSION } from './version';

/** Hosts the supervisor may bind to. Never a routable remote address. */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1']);

export interface StartOptions {
	readonly version?: string;
	readonly host?: string;
	/** Port to bind; 0 selects an ephemeral port (used by tests). */
	readonly port?: number;
	readonly now?: () => Date;
	readonly dataDirectory?: string;
	/** Test-only override. Production tokens are created in the local data directory. */
	readonly authToken?: string;
	/** Test-only relay override. Production uses the supervisor-owned Codex relay. */
	readonly codexRelayFactory?: CodexRelayFactory;
	/** Test-only relay override. Production uses the supervisor-owned Copilot CLI relay. */
	readonly copilotRelayFactory?: CopilotRelayFactory;
	/** Stops this supervisor after its final VS Code extension lease is released. */
	readonly shutdownWhenNoExtensionClients?: boolean;
}

export interface RunningSupervisor {
	readonly url: string;
	readonly host: string;
	readonly port: number;
	readonly instanceId: string;
	readonly authToken: string;
	close(): Promise<void>;
}

function respond(res: import('node:http').ServerResponse, statusCode: number, body: unknown, headOnly: boolean): void {
	const payload = JSON.stringify(body);
	res.writeHead(statusCode, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(payload),
		'cache-control': 'no-store',
		'content-security-policy': "default-src 'none'",
		'cross-origin-resource-policy': 'same-origin',
		'referrer-policy': 'no-referrer',
		'x-content-type-options': 'nosniff',
	});
	res.end(headOnly ? undefined : payload);
}

async function readJsonBody(req: import('node:http').IncomingMessage, maximumBytes: number): Promise<unknown> {
	if (req.method === 'GET' || req.method === 'HEAD') {
		req.resume();
		return undefined;
	}
	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > maximumBytes) {
			throw new Error(`request body exceeds ${maximumBytes} bytes`);
		}
		chunks.push(buffer);
	}
	if (size === 0) {
		return undefined;
	}
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function createRequestListener(health: HealthResponse, service?: SupervisorService): RequestListener {
	return (req, res) => {
		void (async () => {

			const method = req.method ?? 'GET';
			let pathname = '/';
			let query: URLSearchParams | undefined;
			try {
				const url = new URL(req.url ?? '/', 'http://localhost');
				pathname = url.pathname;
				query = url.searchParams;
			} catch {
				pathname = '/';
			}

			if (pathname === '/health' || service === undefined) {
				// Discard any request body so the socket can be reused.
				req.resume();
				const result = route(method, pathname, { health });
				respond(res, result.statusCode, result.body, method === 'HEAD');
				return;
			}
			try {
				const body = await readJsonBody(req, service.maxRequestBytes);
				const authorization = req.headers['x-model-worklog-token'];
				const result = await service.handle({ method, pathname, query, authorization: typeof authorization === 'string' ? authorization : undefined, body });
				respond(res, result.statusCode, result.body, method === 'HEAD');
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				respond(res, 400, { error: { code: 'invalid_request', message } }, method === 'HEAD');
			}
		})();
	};
}

function formatUrl(host: string, port: number): string {
	const displayHost = host === '::1' ? '[::1]' : host;
	return `http://${displayHost}:${port}`;
}

export async function startSupervisor(options: StartOptions = {}): Promise<RunningSupervisor> {
	const host = options.host ?? '127.0.0.1';
	if (!LOOPBACK_HOSTS.has(host)) {
		throw new Error(`refusing to bind supervisor to non-loopback host ${host}`);
	}

	const identity = createIdentity(options.version ?? SUPERVISOR_VERSION, options.now?.() ?? new Date());
	const health = buildHealthResponse(identity);
	let close: (() => Promise<void>) | undefined;
	let shutdownRequested = false;
	const service = await SupervisorService.open({
		dataDirectory: options.dataDirectory ?? defaultDataDirectory(),
		authToken: options.authToken,
		instanceId: identity.instanceId,
		now: options.now,
		codexRelayFactory: options.codexRelayFactory,
		copilotRelayFactory: options.copilotRelayFactory,
		shutdownWhenNoExtensionClients: options.shutdownWhenNoExtensionClients,
		requestShutdown: () => {
			if (shutdownRequested) {
				return;
			}
			shutdownRequested = true;
			setTimeout(() => {
				void close?.();
			}, 0);
		},
	});
	const server: Server = createServer({ maxHeaderSize: 8 * 1024 }, createRequestListener(health, service));
	server.headersTimeout = 10_000;
	server.requestTimeout = 15_000;
	server.keepAliveTimeout = 5_000;

	try {
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error): void => {
				server.removeListener('error', onError);
				reject(error);
			};
			server.once('error', onError);
			server.listen(options.port ?? 0, host, () => {
				server.removeListener('error', onError);
				resolve();
			});
		});
	} catch (error) {
		await service.close();
		throw error;
	}

	const address = server.address() as AddressInfo;
	let closePromise: Promise<void> | undefined;
	close = (): Promise<void> => {
		closePromise ??= (async () => {
			try {
				await new Promise<void>((resolve, reject) => {
					if (!server.listening) {
						resolve();
						return;
					}
					server.close((error) => {
						if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
							reject(error);
						} else {
							resolve();
						}
					});
				});
			} finally {
				await service.close();
			}
		})();
		return closePromise;
	};
	return {
		url: formatUrl(host, address.port),
		host,
		port: address.port,
		instanceId: identity.instanceId,
		authToken: service.token,
		close,
	};
}
