import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import type {
	SyncCommandResult,
	SetupSmokeResult,
	WaitEnvResult,
	Region,
} from "../types.js";
import {
	readDotEnv,
	readVercelTokenFromDisk,
	findWorkspaceRoot,
} from "../env.js";
import { getSetupStatePath, readSetupState } from "../state.js";

export type ParsedArgs = string[];

export async function runStatusCommand(args: ParsedArgs): Promise<number> {
	const json = args.includes("--json");
	printSetupStatus({ json });
	return 0;
}

export function collectSetupStatus() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const appRoot = path.join(workspaceRoot, "apps", "app");
	const envLocalPath = path.join(appRoot, ".env.local");
	const vercelProjectPath = path.join(appRoot, ".vercel", "project.json");
	const env = readDotEnv(envLocalPath);
	const setupStatePath = getSetupStatePath();
	const setupState = readSetupState(setupStatePath);
	const ghVersion = run(["gh", "--version"]);
	const ghToken = run(["gh", "auth", "token"]);
	const vercelVersion = run(["vercel", "--version"]);
	const vercelToken =
		process.env.VERCEL_TOKEN ?? env.VERCEL_TOKEN ?? readVercelTokenFromDisk();
	const vercelProject = toJsonObject(readJson(vercelProjectPath));
	const nextActions: string[] = [];

	if (!existsSync(appRoot)) {
		nextActions.push(
			"Run this command from the Rhapsody repository root, or clone Rhapsody first.",
		);
	}
	if (!ghVersion.ok) {
		nextActions.push(
			"Install the GitHub CLI (`gh`) before setup can create or configure GitHub resources.",
		);
	} else if (!ghToken.ok || !ghToken.stdout.trim()) {
		nextActions.push(
			"Run `gh auth login` before setup can read or mutate GitHub resources.",
		);
	}
	if (!vercelToken) {
		nextActions.push(
			"setup can create or link a Vercel project; run `vercel login` or provide VERCEL_TOKEN.",
		);
	}
	if (!vercelProject) {
		nextActions.push(
			"setup can create or link a Vercel project, or run manual `vercel link`.",
		);
	}
	if (!env.TURSO_DATABASE_URL || !env.TURSO_AUTH_TOKEN) {
		nextActions.push(
			"Turso is not configured yet; setup will provision it through Vercel Marketplace.",
		);
	}
	if (nextActions.length === 0) {
		nextActions.push(
			"Local setup prerequisites look present; continue with Vercel project and Turso provisioning.",
		);
	}

	return {
		ok:
			nextActions.length === 1 &&
			nextActions[0].startsWith("Local setup prerequisites"),
		paths: {
			workspaceRoot,
			appRoot,
			appExists: existsSync(appRoot),
		},
		tools: {
			gh: {
				installed: ghVersion.ok,
				version: firstLine(ghVersion.stdout),
				authTokenPresent: ghToken.ok && ghToken.stdout.trim().length > 0,
			},
			vercel: {
				installed: vercelVersion.ok,
				version: firstLine(vercelVersion.stdout || vercelVersion.stderr),
				tokenPresent: Boolean(vercelToken),
			},
		},
		app: {
			envLocalExists: existsSync(envLocalPath),
			vercelProjectLink: {
				exists: Boolean(vercelProject),
				orgIdPresent:
					typeof vercelProject?.orgId === "string" &&
					vercelProject.orgId.length > 0,
				projectIdPresent:
					typeof vercelProject?.projectId === "string" &&
					vercelProject.projectId.length > 0,
			},
			env: {
				tursoDatabaseUrlPresent: Boolean(env.TURSO_DATABASE_URL),
				tursoAuthTokenPresent: Boolean(env.TURSO_AUTH_TOKEN),
			},
			setupState: {
				path: setupStatePath,
				exists: existsSync(setupStatePath),
				lastUpdatedAt: (setupState.lastUpdatedAt as string | null) ?? null,
				lastCommand:
					typeof setupState.commandState?.["command"] === "string"
						? setupState.commandState["command"]
						: null,
				nextAction:
					typeof setupState.commandState?.["nextAction"] === "string"
						? setupState.commandState["nextAction"]
						: null,
			},
		},
		nextActions,
	};
}

export function collectProjectReadiness() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const appRoot = path.join(workspaceRoot, "apps", "app");
	const statePath = getSetupStatePath();
	const env = readDotEnv(path.join(appRoot, ".env.local"));
	const vercelProjectPath = path.join(appRoot, ".vercel", "project.json");
	const vercelProject = toJsonObject(readJson(vercelProjectPath));
	const vercelToken =
		process.env.VERCEL_TOKEN ?? env.VERCEL_TOKEN ?? readVercelTokenFromDisk();
	const blockers: string[] = [];

	const ghVersion = run(["gh", "--version"]);
	const ghToken = run(["gh", "auth", "token"]);
	const vercelVersion = run(["vercel", "--version"]);
	const remoteUrl = readGitRemoteOriginUrl();
	const repoTarget = normalizeGitRemoteTarget(remoteUrl);

	const github = {
		installed: ghVersion.ok,
		version: firstLine(ghVersion.stdout),
		authTokenPresent: ghToken.ok && ghToken.stdout.trim().length > 0,
		remoteUrl,
		repository: repoTarget,
		repoReadable: false,
		repoSummary: null as string | null,
	};

	if (github.installed && github.authTokenPresent && repoTarget) {
		const repoResult = run([
			"gh",
			"repo",
			"view",
			repoTarget,
			"--json",
			"nameWithOwner,url,defaultBranchRef",
		]);
		if (repoResult.ok) {
			try {
				const repo = JSON.parse(repoResult.stdout) as {
					nameWithOwner?: unknown;
					url?: unknown;
					defaultBranchRef?: { name?: unknown };
				};
				github.repoReadable = true;
				github.repository =
					typeof repo.nameWithOwner === "string" ? repo.nameWithOwner : null;
				github.repoSummary = [
					repo.nameWithOwner,
					repo.url,
					typeof repo.defaultBranchRef?.name === "string"
						? repo.defaultBranchRef.name
						: null,
				]
					.filter(Boolean)
					.join(" | ");
			} catch {
				blockers.push("GitHub repo view returned non-JSON output.");
			}
		} else {
			blockers.push(
				`gh repo view could not read ${repoTarget}; check authentication and repository access.`,
			);
		}
	}

	if (!github.installed) {
		blockers.push(
			"Install the GitHub CLI (`gh`) before setup can read GitHub repository state.",
		);
	}
	if (!github.authTokenPresent) {
		blockers.push(
			"Run `gh auth login` before setup can read repository metadata.",
		);
	}
	if (!remoteUrl) {
		blockers.push(
			"Configure `remote.origin.url` so setup can identify the repository.",
		);
	}

	const projectLink = {
		exists: Boolean(vercelProject),
		orgIdPresent:
			typeof vercelProject?.orgId === "string" &&
			vercelProject.orgId.length > 0,
		projectIdPresent:
			typeof vercelProject?.projectId === "string" &&
			vercelProject.projectId.length > 0,
	};
	const vercel = {
		installed: vercelVersion.ok,
		version: firstLine(vercelVersion.stdout),
		tokenPresent: Boolean(vercelToken),
		projectLink: {
			exists: projectLink.exists,
			orgIdPresent: projectLink.orgIdPresent,
			projectIdPresent: projectLink.projectIdPresent,
		},
	};
	if (!vercel.installed) {
		blockers.push(
			"Install the Vercel CLI (`vercel`) before setup can read project linkage.",
		);
	}
	if (!vercel.tokenPresent) {
		blockers.push(
			"Run `vercel login` or provide VERCEL_TOKEN before setup can verify project linkage.",
		);
	}
	if (!vercel.projectLink.exists) {
		blockers.push(
			"setup can create/link a Vercel project, or run manual `vercel link`.",
		);
	}
	if (
		!vercel.projectLink.orgIdPresent ||
		!vercel.projectLink.projectIdPresent
	) {
		blockers.push(
			"The Vercel project link file exists but is missing orgId/projectId metadata.",
		);
	}

	const nextActions = blockers.length
		? [
				"Fix blockers above, then re-run `rhapsody check-projects --json`.",
				"Run `rhapsody check-projects` for human-readable guidance.",
			]
		: [
				"GitHub and Vercel project prerequisites are ready. Run `rhapsody doctor` to continue.",
				"Re-run `rhapsody check-projects --json` after any configuration changes.",
			];

	return {
		ok: blockers.length === 0,
		statePath,
		github,
		vercel,
		blockers,
		nextActions,
	};
}

export function printSetupStatus({ json }: { json: boolean }) {
	const status = collectSetupStatus();
	if (json) {
		console.log(JSON.stringify(status, null, 2));
		return;
	}

	console.log(`Rhapsody setup status

Repository:
  root: ${status.paths.workspaceRoot}
  app: ${status.paths.appRoot}
  app exists: ${label(status.paths.appExists)}

Tools:
  gh: ${label(status.tools.gh.installed)}${status.tools.gh.version ? ` (${status.tools.gh.version})` : ""}
  gh auth token: ${label(status.tools.gh.authTokenPresent)}
  vercel: ${label(status.tools.vercel.installed)}${status.tools.vercel.version ? ` (${status.tools.vercel.version})` : ""}
  Vercel token: ${label(status.tools.vercel.tokenPresent)}

App workspace:
  .env.local: ${label(status.app.envLocalExists)}
  .vercel/project.json: ${label(status.app.vercelProjectLink.exists)}
  Turso URL: ${label(status.app.env.tursoDatabaseUrlPresent)}
  Turso token: ${label(status.app.env.tursoAuthTokenPresent)}
  setup state: ${label(status.app.setupState.exists)}${status.app.setupState.lastUpdatedAt ? ` (${status.app.setupState.lastUpdatedAt})` : ""}
  last setup command: ${status.app.setupState.lastCommand ?? "none"}

Next action:
  ${status.nextActions[0] ?? "Run `rhapsody doctor --json` for machine-readable details."}
`);
}

export function printSetupCheckProjects({
	json,
	readiness,
}: {
	json: boolean;
	readiness: ReturnType<typeof collectProjectReadiness>;
}) {
	if (json) {
		console.log(JSON.stringify(readiness, null, 2));
		return;
	}

	console.log(`Rhapsody setup check-projects`);
	console.log(`State path: ${readiness.statePath}`);

	console.log(`\nGitHub:`);
	console.log(`  installed: ${label(readiness.github.installed)}`);
	if (readiness.github.version) {
		console.log(`  version: ${readiness.github.version}`);
	}
	console.log(
		`  auth token present: ${label(readiness.github.authTokenPresent)}`,
	);
	console.log(`  remote URL: ${readiness.github.remoteUrl ?? "none"}`);
	console.log(`  repository: ${readiness.github.repository ?? "unknown"}`);
	console.log(`  repo readable: ${label(readiness.github.repoReadable)}`);
	if (readiness.github.repoSummary) {
		console.log(`  repo summary: ${readiness.github.repoSummary}`);
	}

	console.log(`\nVercel:`);
	console.log(`  installed: ${label(readiness.vercel.installed)}`);
	if (readiness.vercel.version) {
		console.log(`  version: ${readiness.vercel.version}`);
	}
	console.log(`  token present: ${label(readiness.vercel.tokenPresent)}`);
	console.log(
		`  project link exists: ${label(readiness.vercel.projectLink.exists)}`,
	);
	console.log(
		`  orgId present: ${label(readiness.vercel.projectLink.orgIdPresent)}`,
	);
	console.log(
		`  projectId present: ${label(readiness.vercel.projectLink.projectIdPresent)}`,
	);

	console.log(`\nNext actions:`);
	for (const action of readiness.nextActions) {
		console.log(`  - ${action}`);
	}
}

export function printSetupSmokeTest({
	json,
	result,
}: {
	json: boolean;
	result: SetupSmokeResult;
}) {
	if (json) {
		console.log(
			JSON.stringify(
				{
					ok: result.ok,
					phase: result.phase,
					baseUrl: result.baseUrl,
					statePath: result.statePath,
					checks: result.checks,
					rootPassword: result.rootPassword,
					blockers: result.blockers,
					nextActions: result.nextActions,
					elapsedMs: result.elapsedMs,
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Rhapsody setup smoke-test`);
	console.log(`Base URL: ${result.baseUrl}`);
	console.log(`State path: ${result.statePath}`);
	for (const check of result.checks) {
		const status = check.status == null ? "n/a" : String(check.status);
		console.log(
			`- ${check.name}: ${check.classification} (${status}) ${
				check.ok ? "ok" : "blocked"
			}`,
		);
	}
	console.log(
		`Root password: requested=${result.rootPassword.requested}, available=${result.rootPassword.available}, source=${result.rootPassword.source}`,
	);
	console.log("\nNext actions:");
	for (const action of result.nextActions) {
		console.log(`  - ${action}`);
	}
	if (result.blockers.length > 0) {
		console.log("\nBlockers:");
		for (const blocker of result.blockers) {
			console.log(`  - ${blocker}`);
		}
	}
	console.log(`\nElapsed: ${result.elapsedMs}ms`);
}

export function printWaitEnvResult({
	json,
	result,
}: {
	json: boolean;
	result: WaitEnvResult;
}) {
	if (json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.log(`Rhapsody setup wait-env

Required environment keys: ${result.requiredEnvKeys.join(", ")}`);

	console.log(`Timeout: ${result.timeoutSeconds}s`);
	console.log(`Interval: ${result.intervalSeconds}s`);
	console.log(`Present keys: ${result.presentEnvKeys.join(", ") || "none"}`);
	console.log(`Missing keys: ${result.missingEnvKeys.join(", ") || "none"}`);
	console.log(`Elapsed: ${result.elapsedMs}ms`);
	console.log(`State path: ${result.statePath}`);
	console.log(`Next actions:`);
	for (const action of result.nextActions) {
		console.log(`  - ${action}`);
	}
}

function run(
	command: string[],
	options: { cwd?: string } = {},
): SyncCommandResult {
	const result = spawnSync(command[0], command.slice(1), {
		encoding: "utf8",
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function firstLine(value: string): string | null {
	return (
		value
			.split(/\r?\n/)
			.find((line) => line.trim().length > 0)
			?.trim() ?? null
	);
}

function readJson(filePath: string): unknown {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function toJsonObject(value: unknown): Record<string, unknown> | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	return value as Record<string, unknown>;
}

function label(value: boolean): "yes" | "no" {
	return value ? "yes" : "no";
}

function readGitRemoteOriginUrl(): string | null {
	try {
		const output = run(["git", "config", "--get", "remote.origin.url"]);
		if (!output.ok || !output.stdout.trim()) {
			return null;
		}
		return output.stdout.trim();
	} catch {
		return null;
	}
}

function normalizeGitRemoteTarget(remoteUrl: string | null): string | null {
	if (!remoteUrl) {
		return null;
	}
	return remoteUrl
		.replace(/^git@github\.com:/, "https://github.com/")
		.replace(/\.git$/, "");
}
