import { normalizeBranchPrefix } from "@/lib/attempt-branch";
import projectConfig from "../rhapsody.config";

export type RhapsodyRunner =
	| "fake"
	| "sandbox-fake"
	| "codex-local"
	| "sandbox-codex";

type RhapsodyRunnerConfigInput = {
	kind: RhapsodyRunner;
	timeoutMs: number;
	sandboxTimeoutBufferMs?: number;
	claimTtlBufferMs?: number;
	runningAttemptTimeoutBufferMs?: number;
	progressIntervalMs?: number;
	progressPreviewLength?: number;
	outputPreviewLength?: number;
};

export type RhapsodyRunnerConfig = {
	kind: RhapsodyRunner;
	timeoutMs: number;
	sandboxTimeoutBufferMs: number;
	claimTtlBufferMs: number;
	runningAttemptTimeoutBufferMs: number;
	progressIntervalMs: number;
	progressPreviewLength: number;
	outputPreviewLength: number;
	sandboxTimeoutMs: number;
	claimTtlMs: number;
	runningAttemptTimeoutMs: number;
};

export type RhapsodyTrackerConfig = {
	kind: "github_project";
	owner: string;
	repository: string;
	projectNumber: number;
	statusField: string;
	activeStatuses: string[];
	terminalStatuses: string[];
};

export type RhapsodyRepositoryConfig = {
	owner: string;
	name: string;
	defaultBranch: string;
	branchPrefix: string;
};

export type RhapsodySchedulerConfig = {
	maxConcurrentRuns: number;
	maxConcurrentRunsByStatus: Record<string, number>;
	maxRetryBackoffMs: number;
};

export type RhapsodyProjectConfig = {
	tracker: RhapsodyTrackerConfig;
	repository: RhapsodyRepositoryConfig;
	scheduler: RhapsodySchedulerConfig;
	runner: RhapsodyRunnerConfigInput;
};

export type RhapsodyResolvedProjectConfig = Omit<
	RhapsodyProjectConfig,
	"runner"
> & {
	runner: RhapsodyRunnerConfig;
};

export type RhapsodyServerEnv = {
	ROOT_PASSWORD: string;
	AUTH_SECRET: string;
	TURSO_DATABASE_URL: string;
	TURSO_AUTH_TOKEN: string;
	GITHUB_TOKEN: string;
	MEDIATOR_SECRET: string;
	VERCEL_TOKEN: string;
	VERCEL_TEAM_ID: string;
	VERCEL_PROJECT_ID: string;
	CRON_SECRET?: string;
	VERCEL_PROTECTION_BYPASS_SECRET?: string;
	RHAPSODY_CODEX_BASE_SNAPSHOT_ID?: string;
	INITIAL_CHATGPT_AUTH_JSON?: string;
	VERCEL_OIDC_ISSUER?: string;
	VERCEL_OIDC_AUDIENCE?: string;
	VERCEL_TEAM_SLUG?: string;
};

export type RhapsodyStateStoreEnv = Pick<
	RhapsodyServerEnv,
	"TURSO_DATABASE_URL" | "TURSO_AUTH_TOKEN"
>;
export type RhapsodyGitHubEnv = Pick<RhapsodyServerEnv, "GITHUB_TOKEN">;
export type RhapsodyMediatorEnv = Pick<RhapsodyServerEnv, "MEDIATOR_SECRET">;
export type RhapsodyAuthSecretEnv = Pick<RhapsodyServerEnv, "AUTH_SECRET">;
export type RhapsodyCronEnv = Pick<RhapsodyServerEnv, "CRON_SECRET">;
export type RhapsodyVercelOidcEnv = Pick<
	RhapsodyServerEnv,
	"VERCEL_OIDC_ISSUER" | "VERCEL_OIDC_AUDIENCE" | "VERCEL_TEAM_SLUG"
>;
export type RhapsodyProtectionBypassEnv = Pick<
	RhapsodyServerEnv,
	"VERCEL_PROTECTION_BYPASS_SECRET"
>;
export type RhapsodySandboxEnv = Pick<
	RhapsodyServerEnv,
	"VERCEL_TOKEN" | "VERCEL_TEAM_ID" | "VERCEL_PROJECT_ID"
>;
export type RhapsodyCodexBaseSnapshotEnv = Pick<
	RhapsodyServerEnv,
	"RHAPSODY_CODEX_BASE_SNAPSHOT_ID"
>;
export type RhapsodyCodexChatGPTEnv = Pick<
	RhapsodyServerEnv,
	"INITIAL_CHATGPT_AUTH_JSON"
>;

const REQUIRED_ENV_KEYS = [
	"ROOT_PASSWORD",
	"AUTH_SECRET",
	"TURSO_DATABASE_URL",
	"TURSO_AUTH_TOKEN",
	"GITHUB_TOKEN",
	"MEDIATOR_SECRET",
	"VERCEL_TOKEN",
	"VERCEL_TEAM_ID",
	"VERCEL_PROJECT_ID",
] as const satisfies readonly (keyof RhapsodyServerEnv)[];

const REQUIRED_STATE_STORE_ENV_KEYS = [
	"TURSO_DATABASE_URL",
	"TURSO_AUTH_TOKEN",
] as const satisfies readonly (keyof RhapsodyStateStoreEnv)[];

const REQUIRED_GITHUB_ENV_KEYS = [
	"GITHUB_TOKEN",
] as const satisfies readonly (keyof RhapsodyGitHubEnv)[];
const REQUIRED_MEDIATOR_ENV_KEYS = [
	"MEDIATOR_SECRET",
] as const satisfies readonly (keyof RhapsodyMediatorEnv)[];
const REQUIRED_AUTH_SECRET_ENV_KEYS = [
	"AUTH_SECRET",
] as const satisfies readonly (keyof RhapsodyAuthSecretEnv)[];
const OPTIONAL_VERCEL_OIDC_ENV_KEYS = [
	"VERCEL_OIDC_ISSUER",
	"VERCEL_OIDC_AUDIENCE",
	"VERCEL_TEAM_SLUG",
] as const satisfies readonly (keyof RhapsodyVercelOidcEnv)[];
const SANDBOX_ENV_KEYS = [
	"VERCEL_TOKEN",
	"VERCEL_TEAM_ID",
	"VERCEL_PROJECT_ID",
] as const satisfies readonly (keyof RhapsodySandboxEnv)[];
const DEFAULT_SANDBOX_TIMEOUT_BUFFER_MS = 5 * 60 * 1000;
const DEFAULT_CLAIM_TTL_BUFFER_MS = 8 * 60 * 1000;
const DEFAULT_RUNNING_ATTEMPT_TIMEOUT_BUFFER_MS = 6 * 60 * 1000;
const DEFAULT_PROGRESS_INTERVAL_MS = 30_000;
const DEFAULT_PROGRESS_PREVIEW_LENGTH = 1000;
const DEFAULT_OUTPUT_PREVIEW_LENGTH = 1000;

type RhapsodyProjectConfigInput = Omit<RhapsodyProjectConfig, "runner"> & {
	runner: RhapsodyRunner | RhapsodyRunnerConfigInput;
};

export class RhapsodyConfigError extends Error {
	constructor(readonly issues: string[]) {
		super(
			`Invalid Rhapsody configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
		);
		this.name = "RhapsodyConfigError";
	}
}

export function loadRhapsodyConfig(): RhapsodyResolvedProjectConfig {
	return normalizeProjectConfig(projectConfig as RhapsodyProjectConfigInput);
}

export function normalizeProjectConfig(
	config: RhapsodyProjectConfigInput,
): RhapsodyResolvedProjectConfig {
	validateProjectConfig(config);

	return {
		...config,
		repository: {
			...config.repository,
			branchPrefix: normalizeBranchPrefix(config.repository.branchPrefix),
		},
		runner: normalizeRunnerConfig(config.runner),
	};
}

export function loadRhapsodyServerEnv(env = process.env): RhapsodyServerEnv {
	return loadRequiredEnv(env, REQUIRED_ENV_KEYS);
}

export function loadRhapsodyStateStoreEnv(
	env = process.env,
): RhapsodyStateStoreEnv {
	return loadRequiredEnv(env, REQUIRED_STATE_STORE_ENV_KEYS);
}

export function loadRhapsodyGitHubEnv(env = process.env): RhapsodyGitHubEnv {
	return loadRequiredEnv(env, REQUIRED_GITHUB_ENV_KEYS);
}

export function loadRhapsodyMediatorEnv(
	env = process.env,
): RhapsodyMediatorEnv {
	return loadRequiredEnv(env, REQUIRED_MEDIATOR_ENV_KEYS);
}

export function loadRhapsodyAuthSecretEnv(
	env = process.env,
): RhapsodyAuthSecretEnv {
	return loadRequiredEnv(env, REQUIRED_AUTH_SECRET_ENV_KEYS);
}

export function loadRhapsodyRootPasswordEnv(
	env = process.env,
): Pick<RhapsodyServerEnv, "ROOT_PASSWORD"> {
	return loadRequiredEnv(env, ["ROOT_PASSWORD"] as const);
}

export function loadRhapsodyAdminAuthEnv(
	env = process.env,
): RhapsodyAuthSecretEnv & Pick<RhapsodyServerEnv, "ROOT_PASSWORD"> {
	return loadRequiredEnv(env, ["ROOT_PASSWORD", "AUTH_SECRET"] as const);
}

export function loadRhapsodyCronEnv(env = process.env): RhapsodyCronEnv {
	return loadOptionalEnv(env, ["CRON_SECRET"] as const);
}

export function loadRhapsodyVercelOidcEnv(
	env = process.env,
): RhapsodyVercelOidcEnv {
	return loadOptionalEnv(env, OPTIONAL_VERCEL_OIDC_ENV_KEYS);
}

export function loadRhapsodyProtectionBypassEnv(
	env = process.env,
): RhapsodyProtectionBypassEnv {
	return loadOptionalEnv(env, ["VERCEL_PROTECTION_BYPASS_SECRET"] as const);
}

export function loadRhapsodyCodexBaseSnapshotEnv(
	env = process.env,
): RhapsodyCodexBaseSnapshotEnv {
	return loadOptionalEnv(env, ["RHAPSODY_CODEX_BASE_SNAPSHOT_ID"] as const);
}

export function loadRhapsodyCodexChatGPTEnv(
	env = process.env,
): RhapsodyCodexChatGPTEnv {
	return loadOptionalEnv(env, ["INITIAL_CHATGPT_AUTH_JSON"] as const);
}

export function loadRhapsodySandboxEnv(
	env = process.env,
): RhapsodySandboxEnv | null {
	const values = {} as RhapsodySandboxEnv;
	const missing: string[] = [];
	const present: string[] = [];

	for (const key of SANDBOX_ENV_KEYS) {
		const value = env[key];

		if (!value?.trim()) {
			missing.push(key);
			continue;
		}

		present.push(key);
		values[key] = value;
	}

	if (present.length === 1 && present[0] === "VERCEL_PROJECT_ID") {
		return null;
	}

	if (present.length === 0) {
		return null;
	}

	if (missing.length > 0) {
		throw new RhapsodyConfigError([
			`Vercel Sandbox credentials must include all of ${SANDBOX_ENV_KEYS.join(", ")} when any are provided`,
			`Missing: ${missing.join(", ")}`,
		]);
	}

	return values;
}

function loadRequiredEnv<const TKey extends string>(
	env: NodeJS.ProcessEnv,
	keys: readonly TKey[],
): Record<TKey, string> {
	const issues: string[] = [];
	const values = {} as Record<TKey, string>;

	for (const key of keys) {
		const value = env[key];

		if (!value?.trim()) {
			issues.push(`${key} is required`);
			continue;
		}

		values[key] = value;
	}

	if (issues.length > 0) {
		throw new RhapsodyConfigError(issues);
	}

	return values;
}

function loadOptionalEnv<const TKey extends string>(
	env: NodeJS.ProcessEnv,
	keys: readonly TKey[],
): Partial<Record<TKey, string>> {
	const values = {} as Partial<Record<TKey, string>>;

	for (const key of keys) {
		const value = env[key];

		if (value?.trim()) {
			values[key] = value;
		}
	}

	return values;
}

export function loadRhapsodyRuntimeConfig(env = process.env) {
	return {
		project: loadRhapsodyConfig(),
		env: loadRhapsodyServerEnv(env),
	};
}

function validateProjectConfig(config: RhapsodyProjectConfigInput) {
	const issues: string[] = [];

	requireNonEmptyString(issues, "tracker.owner", config.tracker.owner);
	requireNonEmptyString(
		issues,
		"tracker.repository",
		config.tracker.repository,
	);
	requirePositiveInteger(
		issues,
		"tracker.projectNumber",
		config.tracker.projectNumber,
	);
	requireNonEmptyString(
		issues,
		"tracker.statusField",
		config.tracker.statusField,
	);
	requireNonEmptyStringArray(
		issues,
		"tracker.activeStatuses",
		config.tracker.activeStatuses,
	);
	requireNonEmptyStringArray(
		issues,
		"tracker.terminalStatuses",
		config.tracker.terminalStatuses,
	);
	requireNonEmptyString(issues, "repository.owner", config.repository.owner);
	requireNonEmptyString(issues, "repository.name", config.repository.name);
	requireNonEmptyString(
		issues,
		"repository.defaultBranch",
		config.repository.defaultBranch,
	);
	requireNonEmptyString(
		issues,
		"repository.branchPrefix",
		config.repository.branchPrefix,
	);
	requirePositiveInteger(
		issues,
		"scheduler.maxConcurrentRuns",
		config.scheduler.maxConcurrentRuns,
	);
	requirePositiveInteger(
		issues,
		"scheduler.maxRetryBackoffMs",
		config.scheduler.maxRetryBackoffMs,
	);
	requireRunnerConfig(issues, "runner", config.runner);

	for (const [status, limit] of Object.entries(
		config.scheduler.maxConcurrentRunsByStatus,
	)) {
		requireNonEmptyString(
			issues,
			"scheduler.maxConcurrentRunsByStatus status",
			status,
		);
		requirePositiveInteger(
			issues,
			`scheduler.maxConcurrentRunsByStatus.${status}`,
			limit,
		);
	}

	if (issues.length > 0) {
		throw new RhapsodyConfigError(issues);
	}
}

export function isRhapsodyRunner(value: unknown): value is RhapsodyRunner {
	return (
		value === "fake" ||
		value === "sandbox-fake" ||
		value === "codex-local" ||
		value === "sandbox-codex"
	);
}

function normalizeRunnerConfig(
	runner: RhapsodyRunner | RhapsodyRunnerConfigInput,
): RhapsodyRunnerConfig {
	if (isRhapsodyRunner(runner)) {
		throw new RhapsodyConfigError([
			"runner must be an object with at least kind and timeoutMs.",
		]);
	}

	const sandboxTimeoutMs =
		runner.timeoutMs +
		(runner.sandboxTimeoutBufferMs ?? DEFAULT_SANDBOX_TIMEOUT_BUFFER_MS);
	const claimTtlMs =
		runner.timeoutMs + (runner.claimTtlBufferMs ?? DEFAULT_CLAIM_TTL_BUFFER_MS);
	const runningAttemptTimeoutMs =
		runner.timeoutMs +
		(runner.runningAttemptTimeoutBufferMs ??
			DEFAULT_RUNNING_ATTEMPT_TIMEOUT_BUFFER_MS);

	return {
		kind: runner.kind,
		timeoutMs: runner.timeoutMs,
		sandboxTimeoutBufferMs:
			runner.sandboxTimeoutBufferMs ?? DEFAULT_SANDBOX_TIMEOUT_BUFFER_MS,
		claimTtlBufferMs: runner.claimTtlBufferMs ?? DEFAULT_CLAIM_TTL_BUFFER_MS,
		runningAttemptTimeoutBufferMs:
			runner.runningAttemptTimeoutBufferMs ??
			DEFAULT_RUNNING_ATTEMPT_TIMEOUT_BUFFER_MS,
		progressIntervalMs:
			runner.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS,
		progressPreviewLength:
			runner.progressPreviewLength ?? DEFAULT_PROGRESS_PREVIEW_LENGTH,
		outputPreviewLength:
			runner.outputPreviewLength ?? DEFAULT_OUTPUT_PREVIEW_LENGTH,
		sandboxTimeoutMs,
		claimTtlMs,
		runningAttemptTimeoutMs,
	};
}

function requireRunnerConfig(
	issues: string[],
	field: string,
	runner: RhapsodyRunner | RhapsodyRunnerConfigInput,
) {
	if (isRhapsodyRunner(runner)) {
		issues.push(
			`${field} must be an object with kind and timeoutMs for runner configuration.`,
		);
		return;
	}

	if (!isRhapsodyRunner(runner.kind)) {
		issues.push(
			`${field}.kind must be one of fake, sandbox-fake, codex-local, sandbox-codex.`,
		);
	}

	requireOptionalPositiveInteger(
		issues,
		`${field}.sandboxTimeoutBufferMs`,
		runner.sandboxTimeoutBufferMs,
	);
	requireOptionalPositiveInteger(
		issues,
		`${field}.claimTtlBufferMs`,
		runner.claimTtlBufferMs,
	);
	requireOptionalPositiveInteger(
		issues,
		`${field}.runningAttemptTimeoutBufferMs`,
		runner.runningAttemptTimeoutBufferMs,
	);
	requireOptionalPositiveInteger(
		issues,
		`${field}.progressIntervalMs`,
		runner.progressIntervalMs,
	);
	requireOptionalPositiveInteger(
		issues,
		`${field}.progressPreviewLength`,
		runner.progressPreviewLength,
	);
	requireOptionalPositiveInteger(
		issues,
		`${field}.outputPreviewLength`,
		runner.outputPreviewLength,
	);
	requirePositiveInteger(issues, `${field}.timeoutMs`, runner.timeoutMs);
}

function requireNonEmptyString(issues: string[], field: string, value: string) {
	if (!value.trim()) {
		issues.push(`${field} must be a non-empty string`);
	}
}

function requireNonEmptyStringArray(
	issues: string[],
	field: string,
	value: string[],
) {
	if (value.length === 0) {
		issues.push(`${field} must include at least one value`);
		return;
	}

	for (const item of value) {
		requireNonEmptyString(issues, field, item);
	}
}

function requirePositiveInteger(
	issues: string[],
	field: string,
	value: number,
) {
	if (!Number.isInteger(value) || value <= 0) {
		issues.push(`${field} must be a positive integer`);
	}
}

function requireOptionalPositiveInteger(
	issues: string[],
	field: string,
	value: number | undefined,
) {
	if (value === undefined) {
		return;
	}

	requirePositiveInteger(issues, field, value);
}
