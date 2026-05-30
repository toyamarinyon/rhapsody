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
	step: string;
	status: "applied" | "skipped" | "blocked" | "missing-source";
	detail: string;
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
		};
	};
	env: {
		migration: {
			present: Record<string, boolean>;
			sources: Record<string, Array<"process" | ".env.local">>;
			missing: string[];
		};
		vercelToken: {
			present: boolean;
			sources: Array<"process" | ".env.local">;
			missing: boolean;
		};
	};
};

type Report = {
	ok: boolean;
	mode: Mode;
	phase: "deploy-preview";
	facts: Facts;
	checks: Check[];
	plannedChanges: PlannedChange[];
	appliedChanges?: AppliedChange[];
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
	previewUrl?: string;
	error?: string;
};

const REQUIRED_MIGRATION_KEYS = [
	"TURSO_DATABASE_URL",
	"TURSO_AUTH_TOKEN",
] as const;
const TARGET_COMMAND = "vercel deploy";

function parseMode(argv: string[]) {
	const args = argv.slice(2);
	if (args.length > 0 && args[0] === "--") {
		args.shift();
	}

	if (args.length === 0) {
		return "dry-run" as const;
	}

	if (args.length === 1 && args[0] === "--dry-run") {
		return "dry-run" as const;
	}

	if (args.length === 2 && args[0] === "--apply" && args[1] === "--yes") {
		return "apply" as const;
	}

	return null;
}

function readEnvFileLines(filePath: string) {
	if (!existsSync(filePath)) {
		return { values: {} as Record<string, string> };
	}

	const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
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
		const value = entry.slice(equalsIndex + 1).trim();
		if (!key) {
			continue;
		}
		values[key] = value;
	}
	return { values };
}

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
	if (result.status === 0) {
		return "authenticated";
	}

	const output = (result.stderr || result.stdout || "").trim();
	if (!output) {
		return `unauthenticated (exit ${result.status})`;
	}

	return output.split("\n")[0] ?? output;
}

function readVercelProjectJson() {
	const filePath = path.join(process.cwd(), ".vercel/project.json");
	if (!existsSync(filePath)) {
		return { exists: false, orgIdPresent: false, projectIdPresent: false };
	}

	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8")) as {
			orgId?: string;
			projectId?: string;
		};
		return {
			exists: true,
			orgIdPresent: Boolean(parsed.orgId?.trim()),
			projectIdPresent: Boolean(parsed.projectId?.trim()),
		};
	} catch {
		return { exists: true, orgIdPresent: false, projectIdPresent: false };
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
		if (String(envLocalValues[key] ?? "").trim()) {
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

function getVercelToken(envLocalValues: Record<string, string>) {
	const processToken = String(process.env.VERCEL_TOKEN ?? "").trim();
	if (processToken) {
		return { value: processToken, source: "process" as const };
	}
	const localToken = String(envLocalValues.VERCEL_TOKEN ?? "").trim();
	if (localToken) {
		return { value: localToken, source: ".env.local" as const };
	}
	return {
		value: undefined as string | undefined,
		source: null as "process" | ".env.local" | null,
	};
}

function buildChecks(args: {
	cli: Facts["cli"];
	auth: Facts["auth"];
	repo: Facts["repo"];
	migration: Facts["env"]["migration"];
	vercelAuthReady: boolean;
}) {
	const migrationMissing = args.migration.missing;
	const vercelLinkReady =
		args.repo.vercelProjectJson.exists &&
		args.repo.vercelProjectJson.orgIdPresent &&
		args.repo.vercelProjectJson.projectIdPresent;
	return [
		{
			name: "vercel-cli",
			ok: args.cli.vercel.available,
			detail: args.cli.vercel.available
				? (args.cli.vercel.version ?? "available")
				: "vercel CLI unavailable",
		},
		{
			name: "pnpm-cli",
			ok: args.cli.pnpm.available,
			detail: args.cli.pnpm.available
				? (args.cli.pnpm.version ?? "available")
				: "pnpm CLI unavailable",
		},
		{
			name: "vercel-auth",
			ok: args.auth.vercel.ok,
			detail: args.auth.vercel.summary,
		},
		{
			name: "package-json",
			ok: args.repo.packageJsonExists,
			detail: args.repo.packageJsonExists ? "present" : "missing",
		},
		{
			name: "db-migrate-script",
			ok: args.repo.dbMigrateScriptExists,
			detail: args.repo.dbMigrateScriptExists ? "present" : "missing",
		},
		{
			name: "vercel-project-link",
			ok: vercelLinkReady,
			detail: args.repo.vercelProjectJson.exists
				? `linked state present (orgId=${args.repo.vercelProjectJson.orgIdPresent ? "yes" : "no"}, projectId=${args.repo.vercelProjectJson.projectIdPresent ? "yes" : "no"})`
				: "missing .vercel/project.json",
		},
		{
			name: "migration-env",
			ok: migrationMissing.length === 0,
			detail:
				migrationMissing.length === 0
					? `migration env present: ${Object.keys(args.migration.present).join(", ")}`
					: `missing migration env source: ${migrationMissing.join(", ")}`,
		},
		{
			name: "vercel-auth-or-token",
			ok: args.vercelAuthReady,
			detail: args.vercelAuthReady
				? "Vercel auth or token is available"
				: "missing",
		},
	];
}

function buildPlannedChanges(mode: Mode) {
	const canRun = mode === "apply" ? "apply" : "future-apply";
	return [
		{
			kind: canRun,
			target: "database",
			action: "Run `pnpm db:migrate` before deployment.",
			reason:
				"Migrates local database schema so preview deploy runs against current migrations.",
			requiresUserConfirmation: mode === "apply",
			wouldWrite: mode === "apply",
		},
		{
			kind: canRun,
			target: "vercel-preview",
			action: "Run `vercel deploy` without --prod.",
			reason: "Deploy uses Vercel auth session or VERCEL_TOKEN.",
			requiresUserConfirmation: mode === "apply",
			wouldWrite: mode === "apply",
		},
	];
}

function extractPreviewUrl(output: string) {
	const lines = output.split(/\r?\n/);
	for (const line of lines) {
		const match = line.match(
			/(https:\/\/[a-zA-Z0-9.-]+\.vercel\.app\/?[\w./-]*)/,
		);
		if (match?.[1]) {
			return match[1];
		}
	}
	return "";
}

function buildUnsupportedArgsNextActions(): string[] {
	return [
		"Run `pnpm setup:deploy-preview -- --dry-run` to inspect preview deploy readiness.",
		"Run `pnpm setup:deploy-preview -- --apply --yes` only after the dry-run blockers are resolved.",
	];
}

function emitUnsupportedArgsError() {
	const report: Report = {
		ok: false,
		mode: "dry-run",
		phase: "deploy-preview",
		facts: {
			cli: {
				vercel: { available: false, version: null },
				pnpm: { available: false, version: null },
			},
			auth: {
				vercel: { ok: false, summary: "unsupported arguments" },
			},
			repo: {
				packageJsonExists: false,
				dbMigrateScriptExists: false,
				vercelProjectJson: {
					exists: false,
					orgIdPresent: false,
					projectIdPresent: false,
				},
			},
			env: {
				migration: {
					present: {},
					sources: {},
					missing: [],
				},
				vercelToken: {
					present: false,
					sources: [],
					missing: true,
				},
			},
		},
		checks: [],
		plannedChanges: [],
		needsUser: [
			"Use no args or --dry-run for inspection, or exact --apply --yes for preview deployment.",
		],
		blocked: ["Unsupported or missing arguments."],
		nextActions: buildUnsupportedArgsNextActions(),
		error:
			"Unsupported arguments. This helper supports no args, --dry-run, or --apply --yes.",
	};

	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = 1;
}

function buildReport(args: {
	mode: Mode;
	cli: Facts["cli"];
	auth: Facts["auth"];
	repo: Facts["repo"];
	migration: Facts["env"]["migration"];
	vercelToken: {
		present: boolean;
		sources: Array<"process" | ".env.local">;
		missing: boolean;
	};
	vercelAuthReady: boolean;
}) {
	const needsUser: string[] = [];
	const blocked: string[] = [];
	const migrationMissing = args.migration.missing;

	if (!args.cli.vercel.available) {
		blocked.push("Vercel CLI is unavailable.");
	}
	if (!args.cli.pnpm.available) {
		blocked.push("pnpm is unavailable.");
	}
	if (!args.auth.vercel.ok) {
		blocked.push(
			"Vercel auth is unavailable. Provide VERCEL_TOKEN or authenticate with Vercel.",
		);
	}
	if (!args.repo.packageJsonExists) {
		blocked.push("package.json is missing.");
	}
	if (!args.repo.dbMigrateScriptExists) {
		blocked.push("db:migrate script is missing.");
	}
	if (!args.repo.vercelProjectJson.exists) {
		blocked.push(
			"Local Vercel project link state (.vercel/project.json) is missing.",
		);
	} else if (!args.repo.vercelProjectJson.orgIdPresent) {
		blocked.push(
			"Local Vercel project link is incomplete: orgId missing in .vercel/project.json.",
		);
	} else if (!args.repo.vercelProjectJson.projectIdPresent) {
		blocked.push(
			"Local Vercel project link is incomplete: projectId missing in .vercel/project.json.",
		);
	}

	if (!args.vercelAuthReady && args.auth.vercel.ok) {
		needsUser.push("Provide VERCEL_TOKEN or authenticate with Vercel.");
	}
	if (migrationMissing.length > 0) {
		for (const key of migrationMissing) {
			blocked.push(`Missing migration credential: ${key}.`);
		}
	}

	const checks = buildChecks({
		cli: args.cli,
		auth: args.auth,
		repo: args.repo,
		migration: args.migration,
		vercelAuthReady: args.vercelAuthReady,
	});
	const nextActions =
		blocked.length > 0
			? ["Resolve blocked prerequisites and rerun helper."]
			: [];
	if (needsUser.length > 0) {
		nextActions.push("Collect missing values and re-run with --dry-run.");
	} else if (blocked.length === 0 && args.mode === "dry-run") {
		nextActions.push("Apply mode is available with --apply --yes.");
	}

	return {
		ok: blocked.length === 0,
		checks,
		needsUser: [...new Set(needsUser)],
		blocked: [...new Set(blocked)],
		plannedChanges: buildPlannedChanges(args.mode),
		nextActions,
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

	const envLocalValues = readEnvFileLines(
		path.join(process.cwd(), ".env.local"),
	).values;
	const vercelProjectJson = readVercelProjectJson();
	const packageJsonPath = path.join(process.cwd(), "package.json");
	const packageJsonExists = existsSync(packageJsonPath);
	const dbMigrateScriptExists = packageJsonExists
		? JSON.parse(readFileSync(packageJsonPath, "utf8"))?.scripts?.[
				"db:migrate"
			] !== undefined
		: false;

	const migration = readEnvPresence(REQUIRED_MIGRATION_KEYS, envLocalValues);
	const vercelTokenInfo = getVercelToken(envLocalValues);
	const auth = {
		vercel: {
			ok: false,
			summary: "",
		},
	};

	if (!cli.vercel.available) {
		auth.vercel = {
			ok: false,
			summary: "vercel CLI unavailable",
		};
	} else if (vercelTokenInfo.value) {
		auth.vercel = {
			ok: true,
			summary: `VERCEL_TOKEN sourced from ${vercelTokenInfo.source}`,
		};
	} else {
		const whoami = run("vercel", ["whoami"]);
		auth.vercel = {
			ok: whoami.status === 0,
			summary: summarizeVercelAuth(whoami),
		};
	}

	const facts: Facts = {
		cli,
		auth,
		repo: {
			packageJsonExists,
			dbMigrateScriptExists,
			vercelProjectJson,
		},
		env: {
			migration: migration,
			vercelToken: {
				present: Boolean(vercelTokenInfo.value),
				sources: vercelTokenInfo.source ? [vercelTokenInfo.source] : [],
				missing: !vercelTokenInfo.value,
			},
		},
	};

	const reportData = buildReport({
		mode,
		cli,
		auth,
		repo: facts.repo,
		migration,
		vercelToken: facts.env.vercelToken,
		vercelAuthReady: auth.vercel.ok,
	});

	const report: Report = {
		ok: reportData.ok,
		mode,
		phase: "deploy-preview",
		facts,
		checks: reportData.checks,
		plannedChanges: reportData.plannedChanges,
		needsUser: reportData.needsUser,
		blocked: reportData.blocked,
		nextActions: reportData.nextActions,
	};

	if (mode === "dry-run") {
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exitCode = report.ok ? 0 : 1;
		return;
	}

	const appliedChanges: AppliedChange[] = [];
	report.appliedChanges = appliedChanges;

	if (!reportData.ok) {
		for (const blocked of report.blocked) {
			appliedChanges.push({
				step: "Prerequisite check",
				status: "blocked",
				detail: blocked,
				wrote: false,
			});
		}

		for (const key of REQUIRED_MIGRATION_KEYS) {
			if (migration.present[key]) {
				continue;
			}
			appliedChanges.push({
				step: `Missing requirement: ${key}`,
				status: "missing-source",
				detail: `${key} must be set in process env or .env.local.`,
				wrote: false,
			});
		}
		report.ok = false;
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exitCode = 1;
		return;
	}

	const migrateResult = run("pnpm", ["db:migrate"], 60_000);
	if (migrateResult.status !== 0) {
		appliedChanges.push({
			step: "pnpm db:migrate",
			status: "blocked",
			detail: `pnpm db:migrate failed (exit ${
				migrateResult.status ?? "unknown"
			}). Verify TURSO_DATABASE_URL and TURSO_AUTH_TOKEN.`,
			wrote: false,
		});
		report.ok = false;
		report.blocked.push(
			"Database migration failed; fix environment and dependency issues and rerun.",
		);
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exitCode = 1;
		return;
	}

	appliedChanges.push({
		step: "pnpm db:migrate",
		status: "applied",
		detail: "Database migration command completed.",
		wrote: true,
	});

	const deployArgs = ["deploy", "--yes"];
	if (vercelTokenInfo.value) {
		deployArgs.push("--token", vercelTokenInfo.value);
	}
	const deployResult = run("vercel", deployArgs, 120_000);
	if (deployResult.status !== 0) {
		appliedChanges.push({
			step: TARGET_COMMAND,
			status: "blocked",
			detail: `vercel deploy failed (exit ${deployResult.status ?? "unknown"}). Check auth, build logs, and deployment state.`,
			wrote: false,
		});
		report.ok = false;
		report.blocked.push("Preview deploy failed.");
		process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
		process.exitCode = 1;
		return;
	}

	const previewUrl = extractPreviewUrl(
		deployResult.stdout || deployResult.stderr,
	);
	if (previewUrl) {
		report.previewUrl = previewUrl;
	}

	appliedChanges.push({
		step: TARGET_COMMAND,
		status: "applied",
		detail: previewUrl
			? `Preview deploy completed: ${previewUrl}`
			: "Preview deploy completed.",
		wrote: true,
	});

	report.nextActions = [
		"Open the preview URL to confirm deployment is healthy.",
		"Run smoke-test flow once GitHub Project items are available.",
		"Re-run dry-run before future deploys to confirm a clean state.",
	];

	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = report.ok ? 0 : 1;
}

main();
