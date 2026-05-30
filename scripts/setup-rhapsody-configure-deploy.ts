import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

type Check = {
	name: string;
	ok: boolean;
	detail: string;
};

type Mode = "dry-run" | "apply";

type PlannedChange = {
	kind: string;
	target: string;
	action: string;
	reason: string;
	requiresUserConfirmation: boolean;
	wouldWrite: boolean;
};

type AppliedChange = {
	key: string;
	environment: "development" | "preview";
	target: string;
	status: "added" | "skipped-existing" | "blocked" | "missing-source";
	action: string;
	wrote: boolean;
};

type Facts = {
	cli: {
		vercel: {
			available: boolean;
			version: string | null;
		};
		pnpm: {
			available: boolean;
			version: string | null;
		};
	};
	auth: {
		vercel: {
			ok: boolean;
			summary: string;
		};
	};
	repo: {
		packageJsonExists: boolean;
		dbMigrateScriptExists: boolean;
		vercelProjectJson: {
			exists: boolean;
			orgIdPresent: boolean;
			projectIdPresent: boolean;
			teamIdPresent: boolean;
		};
		inferredVercelContext: {
			teamIdPresent: boolean;
			projectIdPresent: boolean;
		};
	};
	env: {
		generatedSecrets: {
			present: Record<string, boolean>;
			sources: Record<string, Array<"process" | ".env.local">>;
			missing: string[];
		};
		operatorInputs: {
			present: Record<string, boolean>;
			sources: Record<string, Array<"process" | ".env.local">>;
			missing: string[];
		};
		vercelProjectContext: {
			present: Record<string, boolean>;
			sources: Record<string, Array<"process" | ".env.local">>;
			missing: string[];
			inferredFromLink: {
				VERCEL_TEAM_ID: boolean;
				VERCEL_PROJECT_ID: boolean;
			};
		};
		optional: {
			present: Record<string, boolean>;
			sources: Record<string, Array<"process" | ".env.local">>;
			missing: string[];
		};
	};
	remoteEnvPlan: {
		requiredRuntime: Record<
			string,
			{
				source: "process" | ".env.local" | "vercel-link" | "missing";
				available: boolean;
			}
		>;
		runnerSeed: {
			INITIAL_CHATGPT_AUTH_JSON: {
				source: "process" | ".env.local" | "missing";
				available: boolean;
			};
		};
		optional: Record<
			string,
			{
				source: "process" | ".env.local" | "vercel-link" | "missing";
				available: boolean;
			}
		>;
	};
};

type Report = {
	ok: boolean;
	mode: Mode;
	phase: "configure-deploy";
	facts: Facts;
	checks: Check[];
	plannedChanges: PlannedChange[];
	appliedChanges?: AppliedChange[];
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
	error?: string;
};

const GENERATED_SECRET_KEYS = [
	"ROOT_PASSWORD",
	"AUTH_SECRET",
	"CRON_SECRET",
	"MEDIATOR_SECRET",
] as const;

const OPERATOR_INPUT_KEYS = [
	"TURSO_DATABASE_URL",
	"TURSO_AUTH_TOKEN",
	"GITHUB_TOKEN",
	"VERCEL_TOKEN",
	"INITIAL_CHATGPT_AUTH_JSON",
] as const;

const VERCEL_PROJECT_CONTEXT_KEYS = [
	"VERCEL_TEAM_ID",
	"VERCEL_PROJECT_ID",
] as const;
type VercelProjectContextKey = (typeof VERCEL_PROJECT_CONTEXT_KEYS)[number];

const OPTIONAL_ENV_KEYS = [
	"VERCEL_PROTECTION_BYPASS_SECRET",
	"VERCEL_OIDC_ISSUER",
	"VERCEL_OIDC_AUDIENCE",
	"VERCEL_TEAM_SLUG",
	"RHAPSODY_CODEX_BASE_SNAPSHOT_ID",
] as const;

const REQUIRED_RUNTIME_KEYS = [
	"ROOT_PASSWORD",
	"AUTH_SECRET",
	"TURSO_DATABASE_URL",
	"TURSO_AUTH_TOKEN",
	"GITHUB_TOKEN",
	"MEDIATOR_SECRET",
	"CRON_SECRET",
	"VERCEL_TOKEN",
	"VERCEL_TEAM_ID",
	"VERCEL_PROJECT_ID",
] as const;
type RequiredRuntimeKey = (typeof REQUIRED_RUNTIME_KEYS)[number];

const TARGET_ENVIRONMENTS = ["development", "preview"] as const;
const RUNTIME_AND_SEED_KEYS = [
	...REQUIRED_RUNTIME_KEYS,
	"INITIAL_CHATGPT_AUTH_JSON",
] as const;

function run(
	command: string,
	args: string[],
	timeout = 12_000,
	input?: string,
) {
	return spawnSync(command, args, {
		encoding: "utf8",
		timeout,
		input,
	});
}

function parseMode(argv: string[]) {
	const flags = argv.slice(2);
	if (flags.length === 0) {
		return "dry-run" as const;
	}

	if (flags.length === 1 && flags[0] === "--dry-run") {
		return "dry-run" as const;
	}

	if (flags.length === 2 && flags[0] === "--" && flags[1] === "--dry-run") {
		return "dry-run" as const;
	}

	if (
		(flags.length === 2 && flags[0] === "--apply" && flags[1] === "--yes") ||
		(flags.length === 3 &&
			flags[0] === "--" &&
			flags[1] === "--apply" &&
			flags[2] === "--yes")
	) {
		return "apply" as const;
	}

	return null;
}

function emitUnsupportedArgsError() {
	const report: Report = {
		ok: false,
		mode: "dry-run",
		phase: "configure-deploy",
		facts: {
			cli: {
				vercel: {
					available: false,
					version: null,
				},
				pnpm: {
					available: false,
					version: null,
				},
			},
			auth: {
				vercel: {
					ok: false,
					summary: "unsupported arguments",
				},
			},
			repo: {
				packageJsonExists: false,
				dbMigrateScriptExists: false,
				vercelProjectJson: {
					exists: false,
					orgIdPresent: false,
					projectIdPresent: false,
					teamIdPresent: false,
				},
				inferredVercelContext: {
					teamIdPresent: false,
					projectIdPresent: false,
				},
			},
			env: {
				generatedSecrets: {
					present: {},
					sources: {},
					missing: [],
				},
				operatorInputs: {
					present: {},
					sources: {},
					missing: [],
				},
				vercelProjectContext: {
					present: {},
					sources: {},
					missing: [],
					inferredFromLink: {
						VERCEL_TEAM_ID: false,
						VERCEL_PROJECT_ID: false,
					},
				},
				optional: {
					present: {},
					sources: {},
					missing: [],
				},
			},
			remoteEnvPlan: {
				requiredRuntime: {},
				runnerSeed: {
					INITIAL_CHATGPT_AUTH_JSON: {
						source: "missing",
						available: false,
					},
				},
				optional: {},
			},
		},
		checks: [],
		plannedChanges: [],
		needsUser: [],
		blocked: [],
		nextActions: [],
	};

	process.stdout.write(
		`${JSON.stringify(
			{
				...report,
				error:
					"Unsupported arguments. This helper supports no args, --dry-run, or --apply --yes.",
			},
			null,
			2,
		)}\n`,
	);
	process.exitCode = 1;
}

function checkCommandAvailability(
	command: string,
	args: string[] = ["--version"],
) {
	const result = run(command, args);
	return {
		available: result.status === 0,
		version:
			result.status === 0
				? ((result.stdout || result.stderr).trim().split("\n")[0] ?? null)
				: null,
		error:
			result.status === 0
				? null
				: (
						result.stderr ||
						result.stdout ||
						result.error?.message ||
						`exit ${result.status}`
					).trim(),
	};
}

function summarizeVercelAuth(result: ReturnType<typeof run>) {
	if (result.error) {
		return result.error.message;
	}

	if (result.status === 0) {
		return "authenticated";
	}

	const output = (result.stderr || result.stdout || "").trim();
	if (!output) {
		return `unauthenticated (exit ${result.status})`;
	}

	return output.split("\n")[0] ?? output;
}

function parseEnvFileLines(filePath: string) {
	if (!existsSync(filePath)) {
		return { keys: new Set<string>(), values: {} as Record<string, string> };
	}

	const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
	const keys = new Set<string>();
	const values: Record<string, string> = {};

	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}

		const entry = line.startsWith("export ") ? line.slice(7).trim() : line;
		const equalsIndex = entry.indexOf("=");
		if (equalsIndex <= 0) {
			continue;
		}

		const key = entry.slice(0, equalsIndex).trim();
		const value = entry.slice(equalsIndex + 1);
		if (!key) {
			continue;
		}

		keys.add(key);
		values[key] = value;
	}

	return { keys, values };
}

function getVercelTokenFromSources(args: {
	envLocalValues: Record<string, string>;
}) {
	const tokenFromProcess = String(process.env.VERCEL_TOKEN ?? "").trim();
	if (tokenFromProcess) {
		return tokenFromProcess;
	}

	const tokenFromEnvLocal = args.envLocalValues.VERCEL_TOKEN?.trim();
	return tokenFromEnvLocal && tokenFromEnvLocal.length > 0
		? tokenFromEnvLocal
		: undefined;
}

function readVercelProjectJson() {
	const filePath = path.join(process.cwd(), ".vercel/project.json");
	if (!existsSync(filePath)) {
		return {
			exists: false,
			orgIdPresent: false,
			projectIdPresent: false,
			teamIdPresent: false,
		};
	}

	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
			orgId?: string;
			projectId?: string;
			teamId?: string;
		};

		return {
			exists: true,
			orgIdPresent: Boolean(parsed.orgId?.trim()),
			projectIdPresent: Boolean(parsed.projectId?.trim()),
			teamIdPresent: Boolean(parsed.teamId?.trim()),
		};
	} catch {
		return {
			exists: true,
			orgIdPresent: false,
			projectIdPresent: false,
			teamIdPresent: false,
		};
	}
}

function readVercelProjectValues(args: { exists: boolean }) {
	if (!args.exists) {
		return { teamId: "", projectId: "" };
	}

	const filePath = path.join(process.cwd(), ".vercel/project.json");
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
			orgId?: string;
			projectId?: string;
		};
		return {
			teamId: parsed.orgId?.trim() ?? "",
			projectId: parsed.projectId?.trim() ?? "",
		};
	} catch {
		return { teamId: "", projectId: "" };
	}
}

function readEnvPresence(
	keys: readonly string[],
	envLocalValues: Record<string, string>,
) {
	const present: Record<string, boolean> = {};
	const sources: Record<string, Array<"process" | ".env.local">> = {};
	const missing: string[] = [];

	for (const key of keys) {
		const keySources: Array<"process" | ".env.local"> = [];
		if (String(process.env[key] ?? "").trim()) {
			keySources.push("process");
		}
		const envLocalValue = envLocalValues[key];
		if (String(envLocalValue ?? "").trim()) {
			keySources.push(".env.local");
		}

		const isPresent = keySources.length > 0;
		present[key] = isPresent;
		sources[key] = keySources;
		if (!isPresent) {
			missing.push(key);
		}
	}

	return { present, sources, missing };
}

function readOptionalEnvPresence(
	keys: readonly string[],
	envLocalValues: Record<string, string>,
) {
	return readEnvPresence(keys, envLocalValues);
}

function mergePresence(args: {
	keys: readonly VercelProjectContextKey[];
	envLocalValues: Record<string, string>;
	inferredPresent?: Partial<Record<VercelProjectContextKey, boolean>>;
}) {
	const base = readEnvPresence(args.keys, args.envLocalValues);
	if (!args.inferredPresent) {
		return {
			...base,
			inferredFromLink: {
				VERCEL_TEAM_ID: false,
				VERCEL_PROJECT_ID: false,
			},
		};
	}

	const present = { ...base.present };
	const missing = [...base.missing];
	const inferredFromLink = {
		VERCEL_TEAM_ID: false,
		VERCEL_PROJECT_ID: false,
	};

	for (const key of args.keys) {
		if (base.present[key]) {
			inferredFromLink[key] = false;
			continue;
		}

		const inferred = Boolean(args.inferredPresent[key]);
		inferredFromLink[key] = inferred;
		if (inferred) {
			present[key] = true;
			const index = missing.indexOf(key);
			if (index >= 0) {
				missing.splice(index, 1);
			}
		}
	}

	return {
		present,
		sources: base.sources,
		missing,
		inferredFromLink,
	};
}

function readRemoteEnvPlan(args: { env: Facts["env"]; repo: Facts["repo"] }) {
	const { env, repo } = args;
	type RemoteEnvSource = "process" | ".env.local" | "vercel-link" | "missing";
	type SeedSource = "process" | ".env.local" | "missing";
	const sourceFor = (key: string): RemoteEnvSource => {
		if (env.generatedSecrets.present[key]) {
			return env.generatedSecrets.sources[key]?.includes("process")
				? "process"
				: ".env.local";
		}
		if (env.operatorInputs.present[key]) {
			return env.operatorInputs.sources[key]?.includes("process")
				? "process"
				: ".env.local";
		}
		if (key === "VERCEL_TEAM_ID" && repo.inferredVercelContext.teamIdPresent) {
			return "vercel-link";
		}
		if (
			key === "VERCEL_PROJECT_ID" &&
			repo.inferredVercelContext.projectIdPresent
		) {
			return "vercel-link";
		}
		return "missing";
	};
	const seedSourceFor = (key: string): SeedSource => {
		const source = sourceFor(key);
		return source === "vercel-link" ? "missing" : source;
	};

	const optionalKeys = [
		"VERCEL_PROTECTION_BYPASS_SECRET",
		"VERCEL_OIDC_ISSUER",
		"VERCEL_OIDC_AUDIENCE",
		"VERCEL_TEAM_SLUG",
		"RHAPSODY_CODEX_BASE_SNAPSHOT_ID",
	] as const;

	const requiredRuntime = Object.fromEntries(
		REQUIRED_RUNTIME_KEYS.map((key) => [
			key,
			{
				source: sourceFor(key),
				available: sourceFor(key) !== "missing",
			},
		]),
	) as Facts["remoteEnvPlan"]["requiredRuntime"];

	const runnerSeed = {
		INITIAL_CHATGPT_AUTH_JSON: {
			source: seedSourceFor("INITIAL_CHATGPT_AUTH_JSON"),
			available: seedSourceFor("INITIAL_CHATGPT_AUTH_JSON") !== "missing",
		},
	};

	const optional = Object.fromEntries(
		optionalKeys.map((key) => [
			key,
			{
				source: sourceFor(key),
				available: sourceFor(key) !== "missing",
			},
		]),
	) as Facts["remoteEnvPlan"]["optional"];

	return {
		requiredRuntime,
		runnerSeed,
		optional,
	};
}

function buildChecks(args: {
	cli: Facts["cli"];
	auth: Facts["auth"];
	repo: Facts["repo"];
	remoteEnvPlan: Facts["remoteEnvPlan"];
}) {
	const { cli, auth, repo, remoteEnvPlan } = args;
	const runtimeSourceable = Object.values(remoteEnvPlan.requiredRuntime).every(
		(entry) => entry.available,
	);
	const runnerSeedReady =
		remoteEnvPlan.runnerSeed.INITIAL_CHATGPT_AUTH_JSON.available;
	return [
		{
			name: "vercel-cli",
			ok: cli.vercel.available,
			detail: cli.vercel.available
				? (cli.vercel.version ?? "available")
				: "vercel CLI unavailable",
		},
		{
			name: "pnpm-cli",
			ok: cli.pnpm.available,
			detail: cli.pnpm.available
				? (cli.pnpm.version ?? "available")
				: "pnpm CLI unavailable",
		},
		{
			name: "vercel-auth",
			ok: auth.vercel.ok,
			detail: auth.vercel.summary,
		},
		{
			name: "package-json",
			ok: repo.packageJsonExists,
			detail: repo.packageJsonExists ? "present" : "missing",
		},
		{
			name: "db-migrate-script",
			ok: repo.dbMigrateScriptExists,
			detail: repo.dbMigrateScriptExists ? "present" : "missing",
		},
		{
			name: "vercel-link",
			ok: repo.vercelProjectJson.exists,
			detail: repo.vercelProjectJson.exists
				? `linked state present (orgId=${repo.vercelProjectJson.orgIdPresent ? "yes" : "no"}, teamId=${repo.vercelProjectJson.teamIdPresent ? "yes" : "no"}, projectId=${repo.vercelProjectJson.projectIdPresent ? "yes" : "no"})`
				: "missing .vercel/project.json",
		},
		{
			name: "deployment-env",
			ok: runtimeSourceable,
			detail: runtimeSourceable
				? runnerSeedReady
					? "runtime env sourceable; runner seed present"
					: "runtime env sourceable; runner seed missing"
				: `runtime env missing source for: ${Object.entries(
						remoteEnvPlan.requiredRuntime,
					)
						.filter(([, entry]) => !entry.available)
						.map(([key]) => key)
						.join(", ")}`,
		},
	];
}

function buildPlannedChanges(args: {
	remoteEnvPlan: Facts["remoteEnvPlan"];
	repo: Facts["repo"];
	mode: Mode;
}) {
	const { remoteEnvPlan, repo, mode } = args;
	const configureableRuntimeKeys = Object.entries(remoteEnvPlan.requiredRuntime)
		.filter(([, entry]) => entry.available)
		.map(([key]) => key);
	const missingRuntimeKeys = Object.entries(remoteEnvPlan.requiredRuntime)
		.filter(([, entry]) => !entry.available)
		.map(([key]) => key);
	const envTargets = TARGET_ENVIRONMENTS.join(" or ");
	return [
		{
			kind: "read-only-check",
			target: "Vercel CLI and auth",
			action: "Confirm deploy readiness before any remote apply step.",
			reason:
				"Validation keeps setup non-destructive until explicit apply mode.",
			requiresUserConfirmation: false,
			wouldWrite: false,
		},
		{
			kind: "read-only-check",
			target: ".vercel/project.json",
			action: repo.vercelProjectJson.exists
				? "Use the local Vercel link state as deployment context."
				: "Establish local Vercel project linking before any deploy step.",
			reason: "Remote env writes require a linked project context.",
			requiresUserConfirmation: false,
			wouldWrite: false,
		},
		{
			kind: mode === "apply" ? "apply" : "future-apply",
			target: "Vercel environment variables",
			action: [
				`Target environments: ${envTargets}.`,
				configureableRuntimeKeys.length > 0
					? `Will configure available required runtime env vars in Vercel: ${configureableRuntimeKeys.join(", ")}.`
					: "No required runtime env vars are currently sourceable for remote apply.",
				missingRuntimeKeys.length > 0
					? `Cannot configure missing values until provided: ${missingRuntimeKeys.join(", ")}.`
					: "All required runtime env vars are sourceable.",
				remoteEnvPlan.runnerSeed.INITIAL_CHATGPT_AUTH_JSON.available
					? "Runner seed INITIAL_CHATGPT_AUTH_JSON is available for first-run sandbox-codex setup."
					: "Runner seed INITIAL_CHATGPT_AUTH_JSON is missing for first-run sandbox-codex setup.",
			].join(" "),
			reason:
				mode === "apply"
					? "Apply mode writes only non-production Vercel environment variables and skips existing keys."
					: "Remote env updates are intentionally deferred out of this dry-run helper.",
			requiresUserConfirmation: mode === "apply",
			wouldWrite: mode === "apply",
		},
	];
}

function buildAppliedChangeFromStatus(params: {
	key: string;
	environment: "development" | "preview";
	status: AppliedChange["status"];
	action: string;
	wrote: boolean;
}) {
	return {
		key: params.key,
		environment: params.environment,
		target: "Vercel environment variables",
		status: params.status,
		action: params.action,
		wrote: params.wrote,
	};
}

function valueFromSource(args: {
	key: string;
	source: "process" | ".env.local" | "vercel-link" | "missing";
	teamAndProjectValues: { teamId: string; projectId: string };
	envLocalValues: Record<string, string>;
}) {
	if (args.source === "process") {
		return process.env[args.key] ?? "";
	}
	if (args.source === ".env.local") {
		return args.envLocalValues[args.key] ?? "";
	}
	if (args.key === "VERCEL_TEAM_ID") {
		return args.teamAndProjectValues.teamId ?? "";
	}
	if (args.key === "VERCEL_PROJECT_ID") {
		return args.teamAndProjectValues.projectId ?? "";
	}
	return "";
}

function parseEnvListOutput(output: string) {
	const keys = new Set<string>();
	const trimmed = output.trim();
	if (!trimmed) {
		return keys;
	}
	try {
		const parsed = JSON.parse(trimmed);
		const list = Array.isArray(parsed)
			? parsed
			: Array.isArray((parsed as { envs?: unknown }).envs)
				? ((parsed as { envs: unknown[] }).envs as unknown[])
				: [];
		for (const item of list) {
			if (typeof item === "string") {
				keys.add(item);
				continue;
			}
			if (!item || typeof item !== "object") {
				continue;
			}
			const record = item as Record<string, unknown>;
			const candidate =
				record.key ?? record.name ?? record.variable ?? record.env;
			if (typeof candidate === "string") {
				keys.add(candidate);
			}
		}
		return keys;
	} catch {
		for (const rawLine of trimmed.split(/\r?\n/)) {
			const line = rawLine.trim();
			if (!line || line.startsWith("name") || line.startsWith("KEY")) {
				continue;
			}
			if (line.startsWith("No ") || line.includes("No Environment Variables")) {
				continue;
			}
			const key = line.split(/\s+/)[0];
			if (key) {
				keys.add(key);
			}
		}
	}

	return keys;
}

function fetchExistingRemoteKeys(args: {
	environment: "development" | "preview";
	cliToken: string | undefined;
}) {
	const argsList = [
		"env",
		"list",
		args.environment,
		"--format",
		"json",
	] as string[];
	if (args.cliToken) {
		argsList.push("--token", args.cliToken);
	}
	const listResult = run("vercel", argsList);
	if (listResult.status !== 0) {
		return {
			error:
				(listResult.stderr || listResult.stdout || "list failed").trim() ||
				"vercel env list failed",
			keys: new Set<string>(),
		};
	}
	return {
		error: null as string | null,
		keys: parseEnvListOutput(listResult.stdout ?? ""),
	};
}

function addVercelEnvVar(args: {
	key: string;
	environment: "development" | "preview";
	value: string;
	cliToken: string | undefined;
}) {
	const cliArgs = [
		"env",
		"add",
		args.key,
		args.environment,
		"--yes",
		"--non-interactive",
	] as string[];
	if (args.cliToken) {
		cliArgs.push("--token", args.cliToken);
	}
	const result = run("vercel", cliArgs, 30_000, `${args.value}\n`);
	return {
		ok: result.status === 0,
		error:
			result.status === 0
				? null
				: (result.stderr || result.stdout || "add failed").trim() ||
					"add failed",
	};
}

function buildAuth(args: {
	cliAvailable: boolean;
	cliToken: string | undefined;
}): Facts["auth"] {
	const cliAvailable = args.cliAvailable;
	if (!cliAvailable) {
		return {
			vercel: {
				ok: false,
				summary: "vercel CLI unavailable",
			},
		};
	}
	if (args.cliToken) {
		return {
			vercel: {
				ok: true,
				summary: "VERCEL_TOKEN present",
			},
		};
	}
	const whoami = run("vercel", ["whoami"]);
	return {
		vercel: {
			ok: whoami.status === 0,
			summary: summarizeVercelAuth(whoami),
		},
	};
}

function main() {
	const mode = parseMode(process.argv);
	if (!mode) {
		emitUnsupportedArgsError();
		return;
	}

	const cli = {
		vercel: checkCommandAvailability("vercel"),
		pnpm: checkCommandAvailability("pnpm", ["--version"]),
	};
	const envLocalPath = path.join(process.cwd(), ".env.local");
	const { values: envLocalValues } = parseEnvFileLines(envLocalPath);
	const vercelProjectJson = readVercelProjectJson();
	const vercelProjectValues = readVercelProjectValues({
		exists: vercelProjectJson.exists,
	});
	const cliToken = getVercelTokenFromSources({ envLocalValues });
	const auth = buildAuth({
		cliAvailable: cli.vercel.available,
		cliToken,
	});
	const packageJsonExists = existsSync(
		path.join(process.cwd(), "package.json"),
	);
	const dbMigrateScriptExists = packageJsonExists
		? JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"))
				?.scripts?.["db:migrate"] !== undefined
		: false;
	const env = {
		generatedSecrets: readEnvPresence(GENERATED_SECRET_KEYS, envLocalValues),
		operatorInputs: readEnvPresence(OPERATOR_INPUT_KEYS, envLocalValues),
		vercelProjectContext: mergePresence({
			keys: VERCEL_PROJECT_CONTEXT_KEYS,
			envLocalValues,
			inferredPresent: {
				VERCEL_TEAM_ID: vercelProjectJson.orgIdPresent,
				VERCEL_PROJECT_ID: vercelProjectJson.projectIdPresent,
			},
		}),
		optional: readOptionalEnvPresence(OPTIONAL_ENV_KEYS, envLocalValues),
	};
	const repo = {
		packageJsonExists,
		dbMigrateScriptExists,
		vercelProjectJson,
		inferredVercelContext: {
			teamIdPresent: vercelProjectJson.orgIdPresent,
			projectIdPresent: vercelProjectJson.projectIdPresent,
		},
	};
	const remoteEnvPlan = readRemoteEnvPlan({ env, repo });

	const checks = buildChecks({
		cli,
		auth,
		repo,
		remoteEnvPlan,
	});

	const needsUser: string[] = [];
	const blocked: string[] = [];

	if (!cli.vercel.available) {
		blocked.push("Vercel CLI is unavailable.");
	}
	if (!auth.vercel.ok) {
		blocked.push("Vercel auth is not available.");
	}
	if (!repo.packageJsonExists) {
		blocked.push("package.json is missing.");
	}
	if (!repo.dbMigrateScriptExists) {
		blocked.push("db:migrate script is missing.");
	}
	if (!repo.vercelProjectJson.exists) {
		blocked.push("Local Vercel project link state is missing.");
	}

	for (const key of ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"] as const) {
		if (!env.operatorInputs.present[key]) {
			needsUser.push(`Provide ${key} before deployment configuration.`);
		}
	}

	if (
		!env.generatedSecrets.present.ROOT_PASSWORD ||
		!env.generatedSecrets.present.AUTH_SECRET ||
		!env.generatedSecrets.present.CRON_SECRET ||
		!env.generatedSecrets.present.MEDIATOR_SECRET
	) {
		needsUser.push(
			"Missing generated local secrets; run `pnpm setup:configure-local -- --apply --yes` first if you want those values populated locally.",
		);
	}

	if (!env.operatorInputs.present.VERCEL_TOKEN) {
		needsUser.push("Provide VERCEL_TOKEN before any deploy apply step.");
	}

	if (!env.operatorInputs.present.GITHUB_TOKEN) {
		needsUser.push("Provide GITHUB_TOKEN before deployment configuration.");
	}

	if (!remoteEnvPlan.runnerSeed.INITIAL_CHATGPT_AUTH_JSON.available) {
		needsUser.push(
			"Provide INITIAL_CHATGPT_AUTH_JSON if you want the first sandbox-codex run to be pre-seeded.",
		);
	}

	const runtimeRequiredMissing = Object.entries(remoteEnvPlan.requiredRuntime)
		.filter(([, entry]) => !entry.available)
		.map(([key]) => key);

	const plannedChanges = buildPlannedChanges({
		remoteEnvPlan,
		repo,
		mode,
	});

	const baseReport: Report = {
		ok: blocked.length === 0,
		mode,
		phase: "configure-deploy",
		facts: {
			cli,
			auth,
			repo,
			env,
			remoteEnvPlan,
		},
		checks,
		plannedChanges,
		needsUser: [...new Set(needsUser)],
		blocked,
		nextActions: [
			...(blocked.length > 0 ? ["Resolve blocked prerequisites first."] : []),
			...(runtimeRequiredMissing.length > 0
				? [
						`Cannot apply required runtime Vercel env keys until all sourceable values exist: ${runtimeRequiredMissing.join(
							", ",
						)}.`,
					]
				: []),
			...(needsUser.length > 0
				? [
						"Collect the missing operator-provided values, then re-run the helper with --dry-run.",
					]
				: [
						mode === "dry-run"
							? "Apply mode is available with --apply --yes after prerequisites are satisfied."
							: "Re-run dry-run to confirm no further remote state changes needed.",
					]),
		],
	};

	if (mode === "dry-run") {
		process.stdout.write(`${JSON.stringify(baseReport, null, 2)}\n`);
		process.exitCode = baseReport.ok ? 0 : 1;
		return;
	}

	const applyReport: Report = {
		...baseReport,
		appliedChanges: [],
		ok: true,
	};
	const appliedChanges: AppliedChange[] = [];
	applyReport.appliedChanges = appliedChanges;
	applyReport.blocked = [...new Set(applyReport.blocked)];

	if (
		!cli.vercel.available ||
		!auth.vercel.ok ||
		!repo.vercelProjectJson.exists
	) {
		applyReport.ok = false;
		process.stdout.write(`${JSON.stringify(applyReport, null, 2)}\n`);
		process.exitCode = 1;
		return;
	}

	if (runtimeRequiredMissing.length > 0) {
		for (const envName of TARGET_ENVIRONMENTS) {
			for (const key of REQUIRED_RUNTIME_KEYS) {
				const source = remoteEnvPlan.requiredRuntime[key].source;
				appliedChanges.push(
					buildAppliedChangeFromStatus({
						key,
						environment: envName,
						status: source === "missing" ? "missing-source" : "blocked",
						action:
							source === "missing"
								? "Required runtime value is not sourceable."
								: "Cannot proceed until all required runtime sources are available.",
						wrote: false,
					}),
				);
			}
		}
		applyReport.ok = false;
		applyReport.blocked.push(
			`Required runtime env keys missing source: ${runtimeRequiredMissing.join(", ")}`,
		);
		process.stdout.write(`${JSON.stringify(applyReport, null, 2)}\n`);
		process.exitCode = 1;
		return;
	}

	// prefer a private resolved token from process first, then .env.local
	const resolvedCliToken = cliToken;
	const existingByEnv = {
		development: new Set<string>(),
		preview: new Set<string>(),
	} as Record<"development" | "preview", Set<string>>;
	for (const envName of TARGET_ENVIRONMENTS) {
		const existing = fetchExistingRemoteKeys({
			environment: envName,
			cliToken: resolvedCliToken,
		});
		if (existing.error) {
			applyReport.ok = false;
			applyReport.blocked.push(
				`Failed to read existing env vars from ${envName}: ${existing.error}`,
			);
			for (const key of RUNTIME_AND_SEED_KEYS) {
				appliedChanges.push(
					buildAppliedChangeFromStatus({
						key: `${key}`,
						environment: envName,
						status: "blocked",
						action: "Remote env check failed before apply; no write attempted.",
						wrote: false,
					}),
				);
			}
			continue;
		}
		existingByEnv[envName] = existing.keys;
	}

	for (const envName of TARGET_ENVIRONMENTS) {
		for (const key of RUNTIME_AND_SEED_KEYS) {
			const isRequiredRuntime = key !== "INITIAL_CHATGPT_AUTH_JSON";
			const source = isRequiredRuntime
				? remoteEnvPlan.requiredRuntime[key as RequiredRuntimeKey].source
				: remoteEnvPlan.runnerSeed.INITIAL_CHATGPT_AUTH_JSON.source;

			if (
				isRequiredRuntime
					? !remoteEnvPlan.requiredRuntime[key as RequiredRuntimeKey].available
					: !remoteEnvPlan.runnerSeed.INITIAL_CHATGPT_AUTH_JSON.available
			) {
				if (!isRequiredRuntime) {
					appliedChanges.push(
						buildAppliedChangeFromStatus({
							key: `${key}`,
							environment: envName,
							status: "missing-source",
							action:
								"Runner seed is missing; required for first sandbox-codex run.",
							wrote: false,
						}),
					);
				}
				continue;
			}

			if (existingByEnv[envName].has(key)) {
				appliedChanges.push(
					buildAppliedChangeFromStatus({
						key: `${key}`,
						environment: envName,
						status: "skipped-existing",
						action: `${key} already exists in Vercel ${envName} environment.`,
						wrote: false,
					}),
				);
				continue;
			}

			const value = valueFromSource({
				key,
				source: source as "process" | ".env.local" | "vercel-link" | "missing",
				teamAndProjectValues: vercelProjectValues,
				envLocalValues,
			});
			if (!value) {
				appliedChanges.push(
					buildAppliedChangeFromStatus({
						key: `${key}`,
						environment: envName,
						status: "missing-source",
						action: `${key} source exists for planning but no non-empty value was read.`,
						wrote: false,
					}),
				);
				applyReport.ok = false;
				continue;
			}

			const addResult = addVercelEnvVar({
				key,
				environment: envName,
				value,
				cliToken: resolvedCliToken,
			});
			if (!addResult.ok) {
				applyReport.ok = false;
				applyReport.blocked.push(
					`Failed to add ${key} to ${envName}: ${addResult.error}`,
				);
				appliedChanges.push(
					buildAppliedChangeFromStatus({
						key: `${key}`,
						environment: envName,
						status: "blocked",
						action: `Add command failed: ${addResult.error}`,
						wrote: false,
					}),
				);
			} else {
				appliedChanges.push(
					buildAppliedChangeFromStatus({
						key: `${key}`,
						environment: envName,
						status: "added",
						action: `${key} added to Vercel ${envName} environment.`,
						wrote: true,
					}),
				);
			}
		}
	}

	const allSuccess = appliedChanges.every(
		(change) =>
			change.status === "added" || change.status === "skipped-existing",
	);
	applyReport.ok = applyReport.ok && allSuccess;
	applyReport.blocked = [...new Set(applyReport.blocked)];
	applyReport.needsUser = applyReport.needsUser.filter(
		(entry) =>
			!entry.includes("INITIAL_CHATGPT_AUTH_JSON") ||
			appliedChanges.some(
				(change) =>
					change.key === "INITIAL_CHATGPT_AUTH_JSON" &&
					change.status === "missing-source",
			),
	);

	applyReport.nextActions = [
		...(applyReport.blocked.length > 0
			? ["Resolve blocked items and re-run with --apply --yes."]
			: []),
		...(applyReport.ok
			? ["Re-run dry-run to confirm stable remote env state."]
			: [
					"Fix blocked keys and rerun with --apply --yes to continue, then run --dry-run.",
				]),
	];

	process.stdout.write(`${JSON.stringify(applyReport, null, 2)}\n`);
	process.exitCode = applyReport.ok ? 0 : 1;
}

main();
