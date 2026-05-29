import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

type Check = {
	name: string;
	ok: boolean;
	detail: string;
};

type PlannedChange = {
	kind: string;
	target: string;
	action: string;
	reason: string;
	requiresUserConfirmation: boolean;
	wouldWrite: boolean;
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
				source: "process" | ".env.local" | "missing";
				available: boolean;
			}
		>;
	};
};

type Report = {
	ok: boolean;
	mode: "dry-run";
	phase: "configure-deploy";
	facts: Facts;
	checks: Check[];
	plannedChanges: PlannedChange[];
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
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

function run(command: string, args: string[], timeout = 12_000) {
	return spawnSync(command, args, {
		encoding: "utf8",
		timeout,
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
					"Unsupported arguments. This helper supports no args or --dry-run.",
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

function parseEnvFile(filePath: string) {
	if (!existsSync(filePath)) {
		return new Set<string>();
	}

	const keys = new Set<string>();
	for (const rawLine of readFileSync(filePath, "utf8").split(/\r?\n/)) {
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
		if (key) {
			keys.add(key);
		}
	}

	return keys;
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

function readEnvPresence(keys: readonly string[], envLocalKeys: Set<string>) {
	const present: Record<string, boolean> = {};
	const sources: Record<string, Array<"process" | ".env.local">> = {};
	const missing: string[] = [];

	for (const key of keys) {
		const keySources: Array<"process" | ".env.local"> = [];
		if (String(process.env[key] ?? "").trim()) {
			keySources.push("process");
		}
		if (envLocalKeys.has(key)) {
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
	envLocalKeys: Set<string>,
) {
	return readEnvPresence(keys, envLocalKeys);
}

function mergePresence(args: {
	keys: readonly VercelProjectContextKey[];
	envLocalKeys: Set<string>;
	inferredPresent?: Partial<Record<VercelProjectContextKey, boolean>>;
}) {
	const base = readEnvPresence(args.keys, args.envLocalKeys);
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

	const requiredRuntimeKeys = [
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
	const runnerSeedKey = "INITIAL_CHATGPT_AUTH_JSON" as const;
	const optionalKeys = [
		"VERCEL_PROTECTION_BYPASS_SECRET",
		"VERCEL_OIDC_ISSUER",
		"VERCEL_OIDC_AUDIENCE",
		"VERCEL_TEAM_SLUG",
		"RHAPSODY_CODEX_BASE_SNAPSHOT_ID",
	] as const;

	const requiredRuntime = Object.fromEntries(
		requiredRuntimeKeys.map((key) => [
			key,
			{
				source: sourceFor(key),
				available: sourceFor(key) !== "missing",
			},
		]),
	) as Facts["remoteEnvPlan"]["requiredRuntime"];

	const runnerSeed = {
		INITIAL_CHATGPT_AUTH_JSON: {
			source: seedSourceFor(runnerSeedKey),
			available: seedSourceFor(runnerSeedKey) !== "missing",
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
	env: Facts["env"];
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
}) {
	const { remoteEnvPlan, repo } = args;
	const configureableRuntimeKeys = Object.entries(remoteEnvPlan.requiredRuntime)
		.filter(([, entry]) => entry.available)
		.map(([key]) => key);
	const missingRuntimeKeys = Object.entries(remoteEnvPlan.requiredRuntime)
		.filter(([, entry]) => !entry.available)
		.map(([key]) => key);
	return [
		{
			kind: "read-only-check",
			target: "Vercel CLI and auth",
			action: "Confirm deploy readiness before any remote apply step.",
			reason:
				"Dry-run only validates prerequisites and never mutates Vercel state.",
			requiresUserConfirmation: false,
			wouldWrite: false,
		},
		{
			kind: "read-only-check",
			target: ".vercel/project.json",
			action: repo.vercelProjectJson.exists
				? "Use the local Vercel link state as deployment context."
				: "Establish local Vercel project linking before any deploy step.",
			reason:
				"Deploy configuration needs a linked local project but this helper does not link it.",
			requiresUserConfirmation: false,
			wouldWrite: false,
		},
		{
			kind: "future-apply",
			target: "Vercel environment variables",
			action: [
				configureableRuntimeKeys.length > 0
					? `Would configure available required runtime env vars in Vercel: ${configureableRuntimeKeys.join(", ")}.`
					: "No required runtime env vars are currently sourceable for remote apply.",
				missingRuntimeKeys.length > 0
					? `Cannot configure missing values until provided: ${missingRuntimeKeys.join(", ")}.`
					: "All required runtime env vars are sourceable.",
				remoteEnvPlan.runnerSeed.INITIAL_CHATGPT_AUTH_JSON.available
					? "Runner seed INITIAL_CHATGPT_AUTH_JSON is available for first-run sandbox-codex setup."
					: "Runner seed INITIAL_CHATGPT_AUTH_JSON is missing for first-run sandbox-codex setup.",
			].join(" "),
			reason:
				"Remote env updates are intentionally deferred out of this dry-run helper.",
			requiresUserConfirmation: true,
			wouldWrite: false,
		},
		{
			kind: "future-deploy",
			target: "Vercel preview deployment",
			action:
				"Would run the preview deploy phase after prerequisites are cleared.",
			reason:
				"The dry-run helper only reports readiness and never deploys or migrates.",
			requiresUserConfirmation: true,
			wouldWrite: false,
		},
	];
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
	const vercelWhoamiResult = cli.vercel.available
		? run("vercel", ["whoami"])
		: null;
	const auth = {
		vercel: {
			ok: vercelWhoamiResult ? vercelWhoamiResult.status === 0 : false,
			summary: cli.vercel.available
				? summarizeVercelAuth(vercelWhoamiResult!)
				: "vercel is not available",
		},
	};
	const packageJsonExists = existsSync(
		path.join(process.cwd(), "package.json"),
	);
	const dbMigrateScriptExists = packageJsonExists
		? JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8"))
				?.scripts?.["db:migrate"] !== undefined
		: false;
	const envLocalKeys = parseEnvFile(path.join(process.cwd(), ".env.local"));
	const vercelProjectJson = readVercelProjectJson();
	const env = {
		generatedSecrets: readEnvPresence(GENERATED_SECRET_KEYS, envLocalKeys),
		operatorInputs: readEnvPresence(OPERATOR_INPUT_KEYS, envLocalKeys),
		vercelProjectContext: mergePresence({
			keys: VERCEL_PROJECT_CONTEXT_KEYS,
			envLocalKeys,
			inferredPresent: {
				VERCEL_TEAM_ID: vercelProjectJson.orgIdPresent,
				VERCEL_PROJECT_ID: vercelProjectJson.projectIdPresent,
			},
		}),
		optional: readOptionalEnvPresence(OPTIONAL_ENV_KEYS, envLocalKeys),
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
		env,
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

	const ok =
		blocked.length === 0 &&
		env.operatorInputs.missing.filter(
			(key) => key === "TURSO_DATABASE_URL" || key === "TURSO_AUTH_TOKEN",
		).length === 0;

	const report: Report = {
		ok,
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
		plannedChanges: buildPlannedChanges({ remoteEnvPlan, repo }),
		needsUser,
		blocked,
		nextActions: [
			...(blocked.length > 0 ? ["Resolve blocked prerequisites first."] : []),
			...(needsUser.length > 0
				? [
						"Collect the missing operator-provided values, then re-run the dry-run helper.",
					]
				: ["Proceed to the deploy apply phase when the operator is ready."]),
		],
	};

	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = ok ? 0 : 1;
}

main();
