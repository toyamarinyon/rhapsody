import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import path from "node:path";

import type {
	DeployPreviewPlanResult,
	Region,
	RunResult,
	VercelTokenLookup,
} from "./types.js";
import { getSetupStatePath } from "./state.js";
import {
	findWorkspaceRoot,
	readDotEnv,
	readVercelTokenFromDisk,
} from "./env.js";
import type { JsonObject } from "./types.js";

const vercelCliCommand = ["vercel", "deploy", "--yes"] as const;

export function getVercelTokenForDeployPreview(
	appRoot: string | null,
): VercelTokenLookup {
	if (process.env.VERCEL_TOKEN) {
		return process.env.VERCEL_TOKEN;
	}
	if (appRoot) {
		const env = readDotEnv(path.join(appRoot, ".env.local"));
		if (env.VERCEL_TOKEN) {
			return env.VERCEL_TOKEN;
		}
	}
	return readVercelTokenFromDisk();
}

export function buildDeployPreviewPlan({
	status,
}: {
	status: {
		paths: { appRoot: string; appExists: boolean };
		tools: { vercel: { installed: boolean; tokenPresent: boolean } };
		app: {
			env: { tursoDatabaseUrlPresent: boolean; tursoAuthTokenPresent: boolean };
			vercelProjectLink: { exists: boolean };
		};
	};
}): DeployPreviewPlanResult {
	const statePath = getSetupStatePath();
	const vercelToken = getVercelTokenForDeployPreview(status.paths.appRoot);
	const blockers = collectDeployPreviewBlockers(status);
	const commandPlan = [
		{ name: "pnpm db:migrate", argv: ["pnpm", "db:migrate"] },
		{
			name: vercelToken
				? "vercel deploy --yes --token <redacted>"
				: "vercel deploy --yes",
			argv: vercelToken
				? [...vercelCliCommand, "--token", vercelToken]
				: [...vercelCliCommand],
		},
	];

	return {
		ok: blockers.length === 0,
		appRoot: status.paths.appRoot,
		statePath,
		blockers,
		plannedCommands: commandPlan.map((entry) => entry.name),
		commandPlan,
		nextActions: blockers.length
			? blockers
			: [
					"Run `rhapsody setup deploy-preview --yes` to migrate the DB and deploy.",
					"Review setup state after each step.",
				],
	};
}

export function collectDeployPreviewBlockers(status: {
	paths: { appExists: boolean };
	tools: { vercel: { installed: boolean; tokenPresent: boolean } };
	app: {
		env: { tursoDatabaseUrlPresent: boolean; tursoAuthTokenPresent: boolean };
		vercelProjectLink: { exists: boolean };
	};
}): string[] {
	const blockers: string[] = [];
	if (!status.paths.appExists) {
		blockers.push("Run this command from the Rhapsody repository root.");
	}
	if (!status.tools.vercel.installed) {
		blockers.push(
			"Install the Vercel CLI (`vercel`) before running deploy-preview.",
		);
	}
	if (!status.tools.vercel.tokenPresent) {
		blockers.push(
			"Run `vercel login` or set VERCEL_TOKEN before running deploy-preview.",
		);
	}
	if (!status.app.vercelProjectLink.exists) {
		blockers.push(
			"Link this app to a Vercel project (`vercel link`) before deploy-preview.",
		);
	}
	if (
		!status.app.env.tursoDatabaseUrlPresent ||
		!status.app.env.tursoAuthTokenPresent
	) {
		blockers.push(
			"Provision Turso and write TURSO_DATABASE_URL / TURSO_AUTH_TOKEN to .env.local.",
		);
	}
	return blockers;
}

export function buildProvisionTursoPlan({ region }: { region: Region }): {
	ok: boolean;
	mode: "dry-run";
	region: Region;
	linkDir: string;
	wouldWriteProjectJson: boolean;
	statePath: string;
	applyConfirmationRequired: boolean;
	applyConfirmationProvided: boolean;
	applyReady: boolean;
	command: string;
	commandArgv: string[];
	expectedEnvKeys: string[];
	nextActions: string[];
} {
	const statePath = getSetupStatePath();
	const command =
		"npx -y vercel@53 integration add tursocloud --name rhapsody-db --plan starter -m region=" +
		region +
		" -e production -e preview -e development --no-env-pull";
	const { linkDir, wouldWriteProjectJson } = inferTursoLinkContext();
	const commandArgv = [
		"npx",
		"-y",
		"vercel@53",
		"integration",
		"add",
		"tursocloud",
		"--name",
		"rhapsody-db",
		"--plan",
		"starter",
		"-m",
		`region=${region}`,
		"-e",
		"production",
		"-e",
		"preview",
		"-e",
		"development",
		"--no-env-pull",
	];

	return {
		ok: true,
		mode: "dry-run",
		region,
		linkDir,
		wouldWriteProjectJson,
		statePath,
		applyConfirmationRequired: true,
		applyConfirmationProvided: false,
		applyReady: wouldWriteProjectJson,
		command,
		commandArgv,
		expectedEnvKeys: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
		nextActions: [
			"No resources were created in dry-run mode.",
			"Run again with --yes (and no --dry-run) to execute provisioning.",
		],
	};
}

export function inferTursoLinkContext() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const appProjectJsonPath = path.join(
		workspaceRoot,
		"apps",
		"app",
		".vercel",
		"project.json",
	);

	if (!existsSync(appProjectJsonPath)) {
		return {
			linkDir: path.join(tmpdir(), "rhapsody-setup-unknown"),
			wouldWriteProjectJson: false,
		};
	}

	let projectJson = null;
	try {
		projectJson = JSON.parse(readFileSync(appProjectJsonPath, "utf8"));
	} catch {
		return {
			linkDir: path.join(tmpdir(), "rhapsody-setup-unknown"),
			wouldWriteProjectJson: false,
		};
	}
	const projectId =
		(projectJson as JsonObject).projectId ??
		(typeof (projectJson as { project?: { id?: unknown } }).project === "object"
			? ((projectJson as { project?: { id?: unknown } }).project?.id as string)
			: undefined);
	if (!projectId) {
		return {
			linkDir: path.join(tmpdir(), "rhapsody-setup-unknown"),
			wouldWriteProjectJson: false,
		};
	}

	return {
		linkDir: path.join(tmpdir(), `rhapsody-setup-${projectId}`),
		wouldWriteProjectJson: true,
	};
}

export function runProvisionTursoApply({
	commandArgv,
	cwd,
}: {
	commandArgv: string[];
	cwd: string;
}): RunResult {
	const result = spawnSync(commandArgv[0], commandArgv.slice(1), {
		cwd,
		stdio: "inherit",
		encoding: "utf8",
	});
	return {
		ok: result.status === 0,
		exitCode: result.status ?? 1,
		signal: result.signal,
	};
}
