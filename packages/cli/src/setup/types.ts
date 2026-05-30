export type ParseResult<TData> =
	| ({ ok: true } & TData)
	| { ok: false; error: string };

export function isParseFailure<TData>(
	value: ParseResult<TData>,
): value is { ok: false; error: string } {
	return value.ok === false;
}

export type CommandMode = "apply" | "dry-run";
export type Region = "iad1" | "cle1" | "pdx1" | "dub1" | "bom1" | "hnd1";

export type LegacyRunnerArgs = {
	command: string;
	subcommand?: string;
	args: string[];
};

export type LegacyExitCode = number;

export type RootPasswordSource = "process" | ".env.local" | "missing";
export type ClaimTokenSource =
	| "process"
	| ".env.local"
	| "run-detail"
	| "missing";

export type SecretResolution<TSource extends string> = {
	value: string;
	source: TSource;
};

export type SmokeClassification =
	| "ok"
	| "network-error"
	| "redirect"
	| `status-${number}`
	| "admin-auth-missing"
	| "auth-required"
	| "forbidden";

export type FirstIssuePostClassification =
	| "ok"
	| "validation-error"
	| "unauthorized"
	| "existing-run"
	| "network-error"
	| "server-error"
	| `status-${number}`;

export type StartAttemptClassification =
	| "ok"
	| "validation-error"
	| "unauthorized"
	| "not-found"
	| "already-started"
	| "network-error"
	| "server-error"
	| `status-${number}`;

export const SMOKE_TEST_TIMEOUT_MS = 12_000;
