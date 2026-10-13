import type { ModelLogger } from '../logger';
import { label } from '../privacy';

export interface McpClient {
	callTool(...args: never[]): Promise<unknown>;
	listTools(...args: never[]): Promise<unknown>;
	readResource(...args: never[]): Promise<unknown>;
	listResources(...args: never[]): Promise<unknown>;
	getPrompt(...args: never[]): Promise<unknown>;
	listPrompts(...args: never[]): Promise<unknown>;
}

export interface McpInstrumentationOptions {
	readonly serverName: string;
}

const mcpMethods = new Map<PropertyKey, string>([
	['callTool', 'tools/call'],
	['listTools', 'tools/list'],
	['readResource', 'resources/read'],
	['listResources', 'resources/list'],
	['getPrompt', 'prompts/get'],
	['listPrompts', 'prompts/list'],
]);

function toolName(request: unknown): string | undefined {
	if (typeof request !== 'object' || request === null) { return undefined; }
	try {
		const name: unknown = Object.getOwnPropertyDescriptor(request, 'name')?.value;
		return typeof name === 'string' ? label(name, 256, 'tool') : undefined;
	} catch { return undefined; }
}

export function instrumentMcpClient<Client extends McpClient>(
	client: Client, logger: ModelLogger, options: McpInstrumentationOptions,
): Client {
	const serverName = label(options.serverName, 128, 'mcp');
	const wrappers = new Map<PropertyKey, { original: unknown; wrapped: unknown }>();
	return new Proxy(client, {
		get(target, property) {
			const original: unknown = Reflect.get(target, property, target);
			if (typeof original !== 'function' || property === 'constructor') { return original; }
			const cached = wrappers.get(property);
			if (cached?.original === original) { return cached.wrapped; }
			const method = mcpMethods.get(property);
			const wrapped: unknown = method === undefined ? original.bind(target) : (...args: unknown[]) => {
				const name = method === 'tools/call' ? toolName(args[0]) : undefined;
				return logger.trace({
					name: `mcp.${method}`,
					kind: 'tool',
					attributes: {
						'mcp.method': method,
						'mcp.server.name': serverName,
						...(name === undefined ? {} : { 'tool.name': name }),
					},
					input: args[0],
					serializeResult: (result: unknown) => result,
				}, (): unknown => Reflect.apply(original, target, args));
			};
			wrappers.set(property, { original, wrapped });
			return wrapped;
		},
		set: (target, property, value: unknown) => Reflect.set(target, property, value, target),
	});
}