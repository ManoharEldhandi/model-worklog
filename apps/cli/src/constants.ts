export const CLI_VERSION = '0.1.0' as const;
export const DEFAULT_SUPERVISOR_URL = 'http://127.0.0.1:43199' as const;

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** Conventional CLI process status values. */
export enum ExitCode {
	Ok = 0,
	InvalidInvocation = 2,
	Unavailable = 3,
	Internal = 6,
}
