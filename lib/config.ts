import projectConfig from "../rhapsody.config";

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
	claimTtlMs: number;
	maxRetryBackoffMs: number;
};

export type RhapsodyProjectConfig = {
	tracker: RhapsodyTrackerConfig;
	repository: RhapsodyRepositoryConfig;
	scheduler: RhapsodySchedulerConfig;
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
};

export type RhapsodyStateStoreEnv = Pick<RhapsodyServerEnv, "TURSO_DATABASE_URL" | "TURSO_AUTH_TOKEN">;

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

export class RhapsodyConfigError extends Error {
	constructor(readonly issues: string[]) {
		super(`Invalid Rhapsody configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`);
		this.name = "RhapsodyConfigError";
	}
}

export function loadRhapsodyConfig(): RhapsodyProjectConfig {
	validateProjectConfig(projectConfig);
	return projectConfig;
}

export function loadRhapsodyServerEnv(env = process.env): RhapsodyServerEnv {
	return loadRequiredEnv(env, REQUIRED_ENV_KEYS);
}

export function loadRhapsodyStateStoreEnv(env = process.env): RhapsodyStateStoreEnv {
	return loadRequiredEnv(env, REQUIRED_STATE_STORE_ENV_KEYS);
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

export function loadRhapsodyRuntimeConfig(env = process.env) {
	return {
		project: loadRhapsodyConfig(),
		env: loadRhapsodyServerEnv(env),
	};
}

function validateProjectConfig(config: RhapsodyProjectConfig) {
	const issues: string[] = [];

	requireNonEmptyString(issues, "tracker.owner", config.tracker.owner);
	requireNonEmptyString(issues, "tracker.repository", config.tracker.repository);
	requirePositiveInteger(issues, "tracker.projectNumber", config.tracker.projectNumber);
	requireNonEmptyString(issues, "tracker.statusField", config.tracker.statusField);
	requireNonEmptyStringArray(issues, "tracker.activeStatuses", config.tracker.activeStatuses);
	requireNonEmptyStringArray(issues, "tracker.terminalStatuses", config.tracker.terminalStatuses);
	requireNonEmptyString(issues, "repository.owner", config.repository.owner);
	requireNonEmptyString(issues, "repository.name", config.repository.name);
	requireNonEmptyString(issues, "repository.defaultBranch", config.repository.defaultBranch);
	requireNonEmptyString(issues, "repository.branchPrefix", config.repository.branchPrefix);
	requirePositiveInteger(issues, "scheduler.maxConcurrentRuns", config.scheduler.maxConcurrentRuns);
	requirePositiveInteger(issues, "scheduler.claimTtlMs", config.scheduler.claimTtlMs);
	requirePositiveInteger(issues, "scheduler.maxRetryBackoffMs", config.scheduler.maxRetryBackoffMs);

	for (const [status, limit] of Object.entries(config.scheduler.maxConcurrentRunsByStatus)) {
		requireNonEmptyString(issues, "scheduler.maxConcurrentRunsByStatus status", status);
		requirePositiveInteger(issues, `scheduler.maxConcurrentRunsByStatus.${status}`, limit);
	}

	if (issues.length > 0) {
		throw new RhapsodyConfigError(issues);
	}
}

function requireNonEmptyString(issues: string[], field: string, value: string) {
	if (!value.trim()) {
		issues.push(`${field} must be a non-empty string`);
	}
}

function requireNonEmptyStringArray(issues: string[], field: string, value: string[]) {
	if (value.length === 0) {
		issues.push(`${field} must include at least one value`);
		return;
	}

	for (const item of value) {
		requireNonEmptyString(issues, field, item);
	}
}

function requirePositiveInteger(issues: string[], field: string, value: number) {
	if (!Number.isInteger(value) || value <= 0) {
		issues.push(`${field} must be a positive integer`);
	}
}
