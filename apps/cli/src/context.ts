import type { EnvRecord } from './constants';
import type { OutputFormat, OutputStream } from './output';
import type { FetchLike } from './protocolClient';

export interface CommandContext {
	readonly stdout: OutputStream;
	readonly stderr: OutputStream;
	readonly env: EnvRecord;
	readonly format: OutputFormat;
	readonly color: boolean;
	readonly supervisorUrl: string;
	readonly fetchImpl?: FetchLike;
}
