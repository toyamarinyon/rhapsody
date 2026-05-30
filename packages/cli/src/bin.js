#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const command = process.argv[2] ?? "help";
const subcommand = process.argv[3];
const flags = new Set(process.argv.slice(3));
const cliArgs = process.argv.slice(3);

if (command === "setup") {
	if (subcommand === "plan") {
		const parse = parseSetupPlanArgs(cliArgs);
		if (!parse.ok) {
			console.error(parse.error);
			process.exit(1);
		}
		const { json } = parse;
		const region = parse.region;
		const status = collectSetupStatus();
		const planned = buildSetupPlan({ status, region });
		printSetupPlan({ json, plan: planned });
		process.exit(planned.ok ? 0 : 0);
	}
	if (subcommand === "provision-turso") {
		const parse = parseProvisionTursoArgs(cliArgs);
		if (!parse.ok) {
			console.error(parse.error);
			process.exit(1);
		}
		if (!parse.dryRun) {
			console.error(
				"provision-turso apply mode is not implemented yet; rerun with --dry-run",
			);
			process.exit(1);
		}

		const plan = buildProvisionTursoPlan({ region: parse.region });
		printProvisionTurso({ json: parse.json, plan });
		process.exit(plan.ok ? 0 : 1);
	}
	if (subcommand === "status") {
		printSetupStatus({ json: flags.has("--json") });
		process.exit(0);
	}
	if (subcommand === "--help" || subcommand === "-h") {
		printSetupHelp();
		process.exit(0);
	}
	printSetupPreview();
	process.exit(0);
}

if (command === "help" || command === "--help" || command === "-h") {
	printHelp();
	process.exit(0);
}

console.error(`Unknown command: ${command}`);
console.error("Run `rhapsody --help` for available commands.");
process.exit(1);

function printHelp() {
	console.log(`Rhapsody setup CLI

Usage:
  rhapsody setup [--help]

Commands:
  setup   Prepare a self-hosted Rhapsody deployment
`);
}

function printSetupHelp() {
	console.log(`Usage:
  rhapsody setup
  rhapsody setup status [--json]
  rhapsody setup plan [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]
  rhapsody setup provision-turso --dry-run [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]

The setup command will orchestrate the self-hosted Rhapsody install flow.

Planned phases:
  1. Detect gh and Vercel CLI authentication
  2. Prepare or publish the GitHub repository
  3. Create or reuse the Vercel project
  4. Provision Turso through Vercel Marketplace
  5. Configure Vercel environment variables
  6. Run database migration
  7. Deploy and smoke-test Rhapsody
  8. Hand off the first GitHub Project issue
`);
}

function printSetupPlan({ json, plan }) {
	if (json) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	console.log(`Rhapsody setup plan

Region: ${plan.region}`);

	for (const phase of plan.phases) {
		const marker = phase.status === "blocked" ? "[!]" : "[ ]";
		console.log(`${marker} ${phase.name}`);
		console.log(`    command: ${phase.command}`);
	}

	console.log("\nNext actions:");
	for (const action of plan.nextActions) {
		console.log(`  - ${action}`);
	}
}

function printProvisionTurso({ json, plan }) {
	if (json) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	console.log(`Rhapsody setup provision-turso (dry-run)`);
	console.log(`
No resources were created in dry-run mode.`);
	console.log(`
Region: ${plan.region}`);
	console.log(`Link dir: ${plan.linkDir}`);
	console.log(
		`Would write .vercel/project.json: ${
			plan.wouldWriteProjectJson ? "yes" : "no"
		}`,
	);
	console.log(`Command to run: ${plan.command}`);
	console.log("\nExpected environment variables:");
	for (const envKey of plan.expectedEnvKeys) {
		console.log(`  - ${envKey}`);
	}

	console.log("\nNext actions:");
	for (const action of plan.nextActions) {
		console.log(`  - ${action}`);
	}
}

function printSetupPreview() {
	console.log(`Rhapsody setup CLI scaffold is installed.

Next implementation step:
  add authentication and status probes for gh, Vercel CLI, and the app workspace.

For the current helper flow, run:
  pnpm setup:plan
`);
}

function parseSetupPlanArgs(args) {
	const parsedRegion = parseRegionFlag(args);
	if (!parsedRegion.ok) {
		return parsedRegion;
	}

	return {
		ok: true,
		json: args.includes("--json"),
		region: parsedRegion.region,
	};
}

function parseProvisionTursoArgs(args) {
	const parsedRegion = parseRegionFlag(args);
	if (!parsedRegion.ok) {
		return parsedRegion;
	}

	const dryRun = args.includes("--dry-run");
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody setup provision-turso --dry-run [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]",
		};
	}

	return {
		ok: true,
		json: args.includes("--json"),
		region: parsedRegion.region,
		dryRun,
	};
}

function parseRegionFlag(args) {
	const allowedRegions = new Set([
		"iad1",
		"cle1",
		"pdx1",
		"dub1",
		"bom1",
		"hnd1",
	]);
	let region = "hnd1";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") continue;
		if (arg === "--dry-run") continue;
		if (arg === "--region") {
			const value = args[i + 1];
			if (!value) {
				return {
					ok: false,
					error:
						"Missing value for --region. Use one of: iad1, cle1, pdx1, dub1, bom1, hnd1.",
				};
			}
			if (!allowedRegions.has(value)) {
				return {
					ok: false,
					error: `Invalid region: ${value}. Valid regions: iad1, cle1, pdx1, dub1, bom1, hnd1.`,
				};
			}
			region = value;
			continue;
		}
		if (arg.startsWith("--region=")) {
			const value = arg.slice("--region=".length);
			if (!allowedRegions.has(value)) {
				return {
					ok: false,
					error: `Invalid region: ${value}. Valid regions: iad1, cle1, pdx1, dub1, bom1, hnd1.`,
				};
			}
			region = value;
			continue;
		}
	}

	return {
		ok: true,
		region,
	};
}

function buildProvisionTursoPlan({ region }) {
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
		command,
		commandArgv,
		expectedEnvKeys: ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"],
		nextActions: [
			"No resources were created in dry-run mode.",
			"Re-run with --dry-run to view the exact command and path planning output.",
			"Once apply mode is implemented, rerun this command without --dry-run to execute provisioning.",
		],
	};
}

function inferTursoLinkContext() {
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

	const projectId = projectJson.projectId ?? projectJson.project?.id;
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

function buildSetupPlan({ status, region }) {
	const tursoCommand =
		"npx -y vercel@53 integration add tursocloud --name rhapsody-db --plan starter -m region=" +
		region +
		" -e production -e preview -e development --no-env-pull";

	const phases = [
		{
			name: "Auth check",
			command: "gh auth status && vercel whoami",
			status:
				status.tools.gh.installed && status.tools.vercel.installed
					? "ready"
					: "blocked",
		},
		{
			name: "GitHub repo/project prep",
			command:
				"gh repo view $(git config --get remote.origin.url) --json nameWithOwner",
			status:
				status.tools.gh.installed && status.tools.gh.authTokenPresent
					? "ready"
					: "blocked",
		},
		{
			name: "Vercel project link/create",
			command: "vercel link",
			status: status.app.vercelProjectLink.exists ? "ready" : "ready",
		},
		{
			name: "Turso Marketplace provisioning",
			command: tursoCommand,
			status:
				status.app.env.tursoDatabaseUrlPresent &&
				status.app.env.tursoAuthTokenPresent
					? "ready"
					: "ready",
		},
		{
			name: "Vercel env setup",
			command:
				"vercel env pull --environment=production --environment=preview --environment=development",
			status: status.app.env.tursoDatabaseUrlPresent ? "ready" : "ready",
		},
		{
			name: "Database migration",
			command: "pnpm db:migrate",
			status: "ready",
		},
		{
			name: "Deploy",
			command: "vercel deploy",
			status: "ready",
		},
		{
			name: "Smoke test",
			command:
				"curl -fsS https://your-rhapsody-deployment-url.vercel.app/api/health",
			status: "ready",
		},
		{
			name: "First issue handoff",
			command: "gh project item-add --help",
			status: "ready",
		},
	];

	return {
		ok: status.ok,
		region,
		phases: phases.map((phase) => ({
			name: phase.name,
			command: phase.command,
			status: phase.status,
		})),
		commands: phases.map((phase) => phase.command),
		nextActions: status.nextActions,
	};
}

function printSetupStatus({ json }) {
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

Next action:
  ${status.nextActions[0] ?? "Run `rhapsody setup status --json` for machine-readable details."}
`);
}

function collectSetupStatus() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const appRoot = path.join(workspaceRoot, "apps", "app");
	const envLocalPath = path.join(appRoot, ".env.local");
	const vercelProjectPath = path.join(appRoot, ".vercel", "project.json");
	const env = readDotEnv(envLocalPath);
	const ghVersion = run(["gh", "--version"]);
	const ghToken = run(["gh", "auth", "token"]);
	const vercelVersion = run(["vercel", "--version"]);
	const vercelToken = process.env.VERCEL_TOKEN ?? readVercelTokenFromDisk();
	const vercelProject = readJson(vercelProjectPath);
	const nextActions = [];

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
			"Run `vercel login` or provide VERCEL_TOKEN before setup can configure Vercel resources.",
		);
	}
	if (!vercelProject) {
		nextActions.push(
			"The app is not linked to a Vercel project yet; setup will create or link one.",
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
		},
		nextActions,
	};
}

function findWorkspaceRoot(start) {
	let current = start;
	while (true) {
		if (
			existsSync(path.join(current, "pnpm-workspace.yaml")) &&
			existsSync(path.join(current, "apps", "app", "package.json"))
		) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) return start;
		current = parent;
	}
}

function readDotEnv(filePath) {
	if (!existsSync(filePath)) return {};
	const result = {};
	for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const index = trimmed.indexOf("=");
		if (index === -1) continue;
		const key = trimmed.slice(0, index).trim();
		let value = trimmed.slice(index + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		result[key] = value;
	}
	return result;
}

function readVercelTokenFromDisk() {
	const candidates = [
		path.join(
			homedir(),
			"Library",
			"Application Support",
			"com.vercel.cli",
			"auth.json",
		),
		path.join(homedir(), ".local", "share", "com.vercel.cli", "auth.json"),
	];
	for (const candidate of candidates) {
		const data = readJson(candidate);
		if (typeof data?.token === "string" && data.token.length > 0)
			return data.token;
	}
	return null;
}

function readJson(filePath) {
	try {
		return JSON.parse(readFileSync(filePath, "utf8"));
	} catch {
		return null;
	}
}

function run(command) {
	const result = spawnSync(command[0], command.slice(1), {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function firstLine(value) {
	return (
		value
			.split(/\r?\n/)
			.find((line) => line.trim().length > 0)
			?.trim() ?? null
	);
}

function label(value) {
	return value ? "yes" : "no";
}
