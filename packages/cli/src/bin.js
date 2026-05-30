#!/usr/bin/env node

import {
	copyFileSync,
	unlinkSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const command = process.argv[2] ?? "help";
const subcommand = process.argv[3];
const flags = new Set(process.argv.slice(3));
const cliArgs = process.argv.slice(3);

if (command === "setup") {
	if (subcommand === "check-projects") {
		const parse = parseSetupCheckProjectsArgs(cliArgs);
		if (!parse.ok) {
			console.error(parse.error);
			process.exit(1);
		}
		const readiness = collectProjectReadiness();
		printSetupCheckProjects({ json: parse.json, readiness });
		recordSetupState({
			command: "check-projects",
			nextAction: readiness.ok ? "complete" : "blocked",
			statePath: readiness.statePath,
			blockers: readiness.blockers,
			nextActions: readiness.nextActions,
			github: {
				installed: readiness.github.installed,
				authTokenPresent: readiness.github.authTokenPresent,
				remoteUrl: readiness.github.remoteUrl,
				repository: readiness.github.repository,
				repoReadable: readiness.github.repoReadable,
				repoSummary: readiness.github.repoSummary,
			},
			vercel: {
				installed: readiness.vercel.installed,
				tokenPresent: readiness.vercel.tokenPresent,
				projectLink: readiness.vercel.projectLink,
			},
		});
		process.exit(readiness.ok ? 0 : 1);
	}
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
	if (subcommand === "deploy-preview") {
		const parse = parseDeployPreviewArgs(cliArgs);
		if (!parse.ok) {
			console.error(parse.error);
			process.exit(1);
		}

		const status = collectSetupStatus();
		const plan = buildDeployPreviewPlan({ status });
		const mode = parse.dryRun ? "dry-run" : "apply";
		const statePath = plan.statePath;

		recordSetupState({
			command: "deploy-preview",
			mode,
			appRoot: plan.appRoot,
			statePath,
			plannedCommands: plan.plannedCommands,
			blockers: plan.blockers,
			before: {
				commandCount: plan.plannedCommands.length,
			},
			nextAction: plan.ok ? "ready" : "blocked",
		});

		if (!parse.dryRun && !parse.yes) {
			console.error(
				"rhapsody setup deploy-preview requires confirmation in apply mode. Pass --yes to execute.",
			);
			recordSetupState({
				command: "deploy-preview",
				mode,
				appRoot: plan.appRoot,
				statePath,
				plannedCommands: plan.plannedCommands,
				blockers: plan.blockers,
				nextAction: "blocked",
				nextActions: plan.nextActions,
			});
			process.exit(1);
		}

		if (parse.dryRun || !plan.ok) {
			printDeployPreviewPlan({
				json: parse.json,
				mode,
				plan,
			});
			recordSetupState({
				command: "deploy-preview",
				mode,
				appRoot: plan.appRoot,
				statePath,
				plannedCommands: plan.plannedCommands,
				blockers: plan.blockers,
				nextAction: plan.ok ? "ready" : "blocked",
				nextActions: plan.nextActions,
			});
			process.exit(plan.ok ? 0 : 1);
		}

		const appliedSteps = [];
		let failed = false;
		for (const step of plan.commandPlan) {
			const result = runCommandFromApp({
				cwd: plan.appRoot,
				argv: step.argv,
			});
			appliedSteps.push({
				command: step.name,
				exitCode: result.exitCode,
				signal: result.signal,
			});
			if (!result.ok) {
				failed = true;
				break;
			}
		}
		const ok = !failed;
		recordSetupState({
			command: "deploy-preview",
			mode,
			appRoot: plan.appRoot,
			statePath,
			plannedCommands: plan.plannedCommands,
			blockers: plan.blockers,
			appliedSteps: appliedSteps.map((step) => ({
				command: step.command,
				exitCode: step.exitCode,
				signal: step.signal,
			})),
			nextAction: ok ? "complete" : "failed",
			nextActions: ok
				? ["Deployment completed. Check app logs and deployment URL."]
				: [
						"Re-run `rhapsody setup deploy-preview --yes` after resolving blocking issues.",
					],
		});

		printDeployPreviewPlan({
			json: parse.json,
			mode,
			plan: {
				...plan,
				appliedSteps: appliedSteps.map((step) => ({
					command: step.command,
					exitCode: step.exitCode,
				})),
			},
		});
		process.exit(ok ? 0 : 1);
	}
	if (subcommand === "wait-env") {
		const parse = parseWaitEnvArgs(cliArgs);
		if (!parse.ok) {
			console.error(parse.error);
			process.exit(1);
		}
		const result = waitForEnv({
			timeoutSeconds: parse.timeoutSeconds,
			intervalSeconds: parse.intervalSeconds,
		});
		recordWaitEnvSetupState(result);
		printWaitEnvResult({ json: parse.json, result });
		process.exit(result.ok ? 0 : 1);
	}
	if (subcommand === "provision-turso") {
		const parse = parseProvisionTursoArgs(cliArgs);
		if (!parse.ok) {
			console.error(parse.error);
			process.exit(1);
		}
		if (!parse.dryRun && !parse.yes) {
			console.error(
				"rhapsody setup provision-turso requires confirmation in apply mode. Pass --yes to execute.",
			);
			process.exit(1);
		}

		const plan = buildProvisionTursoPlan({ region: parse.region });
		plan.applyConfirmationProvided = parse.yes;
		if (!parse.dryRun && !plan.applyReady) {
			console.error(
				`Cannot execute apply without source .vercel/project.json at ${inferTursoProjectJsonPath()}`,
			);
			process.exit(1);
		}
		if (parse.dryRun) {
			printProvisionTurso({
				json: parse.json,
				plan,
			});
			process.exit(plan.ok ? 0 : 1);
		}

		recordSetupState({
			command: "provision-turso",
			mode: "apply",
			region: parse.region,
			applyConfirmationProvided: parse.yes,
			before: stateSnapshot(plan.linkDir, plan.wouldWriteProjectJson),
			after: {
				linkDir: plan.linkDir,
				linkDirExists: existsSync(plan.linkDir),
				wouldWriteProjectJson: plan.wouldWriteProjectJson,
				preparedProjectJson: existsSync(
					path.join(plan.linkDir, ".vercel", "project.json"),
				),
			},
			nextAction: "prepare-link-dir",
		});

		const prepared = prepareTursoLinkDirectory({
			linkDir: plan.linkDir,
			projectJsonPath: inferTursoProjectJsonPath(),
		});
		recordSetupState({
			command: "provision-turso",
			mode: "apply",
			region: parse.region,
			applyConfirmationProvided: parse.yes,
			before: {
				linkDir: plan.linkDir,
				linkDirExists: existsSync(plan.linkDir),
				wouldWriteProjectJson: plan.wouldWriteProjectJson,
				preparedProjectJson: false,
			},
			after: {
				linkDir: plan.linkDir,
				linkDirExists: existsSync(plan.linkDir),
				wouldWriteProjectJson: plan.wouldWriteProjectJson,
				preparedProjectJson: prepared.prepared,
				projectJsonTarget: prepared.projectJsonTarget,
			},
			nextAction: "run-command",
		});

		const result = runProvisionTursoApply({
			commandArgv: plan.commandArgv,
			cwd: plan.linkDir,
		});
		recordSetupState({
			command: "provision-turso",
			mode: "apply",
			region: parse.region,
			applyConfirmationProvided: parse.yes,
			before: {
				linkDir: plan.linkDir,
				linkDirExists: existsSync(plan.linkDir),
				wouldWriteProjectJson: plan.wouldWriteProjectJson,
				preparedProjectJson: prepared.prepared,
				projectJsonTarget: prepared.projectJsonTarget,
			},
			after: {
				linkDir: plan.linkDir,
				linkDirExists: existsSync(plan.linkDir),
				wouldWriteProjectJson: plan.wouldWriteProjectJson,
				preparedProjectJson: prepared.prepared,
				projectJsonTarget: prepared.projectJsonTarget,
				exitCode: result.exitCode,
				signal: result.signal,
			},
			exitCode: result.exitCode,
			signal: result.signal,
			nextAction: result.ok ? "complete" : "failed",
		});
		process.exit(result.ok ? 0 : 1);
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
  rhapsody setup check-projects [--json]
  rhapsody setup plan [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]
  rhapsody setup wait-env [--json] [--timeout <seconds>] [--interval <seconds>]
  rhapsody setup deploy-preview --dry-run [--json]
  rhapsody setup deploy-preview --yes [--json]
  rhapsody setup provision-turso --dry-run [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]
  rhapsody setup provision-turso --yes [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]

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

function parseSetupCheckProjectsArgs(args) {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error: "Usage: rhapsody setup check-projects [--json]",
		};
	}
	return {
		ok: true,
		json: args.includes("--json"),
	};
}

function printSetupCheckProjects({ json, readiness }) {
	if (json) {
		console.log(JSON.stringify(readiness, null, 2));
		return;
	}
	console.log(`Rhapsody setup check-projects`);
	console.log(`State path: ${readiness.statePath}`);

	console.log("\nGitHub:");
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

	console.log("\nVercel:");
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

	console.log("\nNext actions:");
	for (const action of readiness.nextActions) {
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
	console.log(`Apply confirmation required: ${plan.applyConfirmationRequired}`);
	console.log(`Apply confirmation provided: ${plan.applyConfirmationProvided}`);
	console.log(`Apply-ready: ${plan.applyReady}`);
	console.log(`Setup state path: ${plan.statePath}`);
	console.log("\nExpected environment variables:");
	for (const envKey of plan.expectedEnvKeys) {
		console.log(`  - ${envKey}`);
	}

	console.log("\nNext actions:");
	for (const action of plan.nextActions) {
		console.log(`  - ${action}`);
	}
}

function printDeployPreviewPlan({ json, mode, plan }) {
	if (json) {
		const payload = {
			ok: plan.ok,
			mode,
			appRoot: plan.appRoot,
			statePath: plan.statePath,
			plannedCommands: plan.plannedCommands,
			blockers: plan.blockers,
			nextActions: plan.nextActions,
		};
		if (mode === "apply") {
			payload.appliedSteps = plan.appliedSteps ?? [];
		}
		console.log(JSON.stringify(payload, null, 2));
		return;
	}

	console.log(
		`Rhapsody setup deploy-preview (${mode === "dry-run" ? "dry-run" : "apply"})`,
	);
	console.log(`App root: ${plan.appRoot}`);
	console.log(`State path: ${plan.statePath}`);
	console.log("\nPlanned command names:");
	for (const command of plan.plannedCommands) {
		console.log(`  - ${command}`);
	}
	console.log("\nBlockers:");
	if (plan.blockers.length === 0) {
		console.log("  none");
	} else {
		for (const blocker of plan.blockers) {
			console.log(`  - ${blocker}`);
		}
	}
	if (mode === "apply" && plan.appliedSteps) {
		console.log("\nApplied steps:");
		for (const step of plan.appliedSteps) {
			console.log(`  - ${step.command}: exit ${step.exitCode}`);
		}
	}
	console.log("\nNext actions:");
	for (const action of plan.nextActions) {
		console.log(`  - ${action}`);
	}
}

function printWaitEnvResult({ json, result }) {
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
				"Usage: rhapsody setup provision-turso (--dry-run|--yes) [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]",
		};
	}

	return {
		ok: true,
		json: args.includes("--json"),
		region: parsedRegion.region,
		dryRun,
		yes: args.includes("--yes"),
	};
}

function parseDeployPreviewArgs(args) {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error: "Usage: rhapsody setup deploy-preview (--dry-run|--yes) [--json]",
		};
	}
	const dryRun = args.includes("--dry-run");
	const yes = args.includes("--yes");
	return {
		ok: true,
		json: args.includes("--json"),
		dryRun,
		yes,
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

function parseWaitEnvArgs(args) {
	const timeoutResult = parseTimeoutFlag(args);
	if (!timeoutResult.ok) {
		return timeoutResult;
	}
	const intervalResult = parseIntervalFlag(args);
	if (!intervalResult.ok) {
		return intervalResult;
	}
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody setup wait-env [--json] [--timeout <seconds>] [--interval <seconds>]",
		};
	}
	return {
		ok: true,
		json: args.includes("--json"),
		timeoutSeconds: timeoutResult.value,
		intervalSeconds: intervalResult.value,
	};
}

function parseTimeoutFlag(args) {
	return parseIntegerSecondsFlag({
		args,
		name: "--timeout",
		defaultValue: 30,
	});
}

function parseIntervalFlag(args) {
	return parseIntegerSecondsFlag({
		args,
		name: "--interval",
		defaultValue: 3,
		minValue: 1,
	});
}

function parseIntegerSecondsFlag({ args, name, defaultValue, minValue = 0 }) {
	let valueRaw = null;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === name) {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return {
					ok: false,
					error: `${name} requires a value in seconds.`,
				};
			}
			valueRaw = value;
			continue;
		}
		if (arg.startsWith(`${name}=`)) {
			valueRaw = arg.slice(name.length + 1);
			continue;
		}
	}
	if (valueRaw === null) {
		return { ok: true, value: defaultValue };
	}
	if (!/^\d+$/.test(valueRaw)) {
		return {
			ok: false,
			error: `${name} must be a non-negative integer (seconds).`,
		};
	}
	const value = Number.parseInt(valueRaw, 10);
	if (!Number.isFinite(value) || value < minValue) {
		return {
			ok: false,
			error:
				minValue === 0
					? `${name} must be a non-negative integer (seconds).`
					: `${name} must be an integer greater than or equal to ${minValue} (seconds).`,
		};
	}
	return {
		ok: true,
		value,
	};
}

function waitForEnv({ timeoutSeconds, intervalSeconds }) {
	const start = Date.now();
	const timeoutMs = timeoutSeconds * 1000;
	const intervalMs = intervalSeconds * 1000;
	const requiredEnvKeys = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
	const statePath = getSetupStatePath();

	let presentEnvKeys = [];
	let missingEnvKeys = [...requiredEnvKeys];
	let nextActions = [];
	while (true) {
		const status = collectSetupStatus();
		const observed = gatherEnvStatus({
			status,
			requiredEnvKeys,
		});
		presentEnvKeys = observed.presentEnvKeys;
		missingEnvKeys = observed.missingEnvKeys;
		nextActions = observed.missingEnvKeys.length
			? [
					"Provision Turso through Vercel Marketplace or set missing keys in .env.local.",
					"Re-run `rhapsody setup wait-env` until all keys are available.",
				]
			: [
					"Turso env vars are available.",
					"Continue with `rhapsody setup plan` or next setup phase commands.",
				];
		const elapsedMs = Date.now() - start;
		if (missingEnvKeys.length === 0) {
			return {
				ok: true,
				requiredEnvKeys,
				presentEnvKeys,
				missingEnvKeys,
				timeoutSeconds,
				intervalSeconds,
				elapsedMs,
				statePath,
				nextActions,
			};
		}
		if (elapsedMs >= timeoutMs || timeoutMs === 0) {
			return {
				ok: false,
				requiredEnvKeys,
				presentEnvKeys,
				missingEnvKeys,
				timeoutSeconds,
				intervalSeconds,
				elapsedMs,
				statePath,
				nextActions,
			};
		}
		if (intervalMs > 0) {
			sleepSync(intervalMs);
		}
	}
}

function buildDeployPreviewPlan({ status }) {
	const statePath = getSetupStatePath();
	const vercelToken = getVercelTokenForDeployPreview(status.paths.appRoot);
	const blockers = collectDeployPreviewBlockers(status);
	const commandPlan = [
		{
			name: "pnpm db:migrate",
			argv: ["pnpm", "db:migrate"],
		},
		{
			name: vercelToken
				? "vercel deploy --yes --token <redacted>"
				: "vercel deploy --yes",
			argv: vercelToken
				? ["vercel", "deploy", "--yes", "--token", vercelToken]
				: ["vercel", "deploy", "--yes"],
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

function collectDeployPreviewBlockers(status) {
	const blockers = [];
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

function getVercelTokenForDeployPreview(appRoot) {
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

function gatherEnvStatus({ status, requiredEnvKeys }) {
	const localPath = path.join(status.paths.appRoot, ".env.local");
	const env = readDotEnv(localPath);
	const mergedEnv = { ...env };
	const localMissing = requiredEnvKeys.filter((key) => !mergedEnv[key]);
	if (localMissing.length > 0) {
		const vercelPull = maybeReadVercelEnv(status);
		for (const [key, value] of Object.entries(vercelPull)) {
			if (!mergedEnv[key] && value) {
				mergedEnv[key] = value;
			}
		}
	}
	const presentEnvKeys = [];
	const missingEnvKeys = [];
	for (const key of requiredEnvKeys) {
		if (mergedEnv[key]) {
			presentEnvKeys.push(key);
		} else {
			missingEnvKeys.push(key);
		}
	}
	return { presentEnvKeys, missingEnvKeys };
}

function maybeReadVercelEnv(status) {
	if (
		!status.tools.vercel.installed ||
		!status.tools.vercel.tokenPresent ||
		!status.app.vercelProjectLink.exists
	) {
		return {};
	}

	const tempPath = path.join(
		tmpdir(),
		`rhapsody-setup-env-${Date.now()}-${Math.random().toString(16).slice(2)}.env`,
	);
	const result = run(
		["vercel", "env", "pull", tempPath, "--environment=development"],
		{
			cwd: status.paths.appRoot,
		},
	);
	if (!result.ok || !existsSync(tempPath)) {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
		return {};
	}
	const pulledEnv = readDotEnv(tempPath);
	unlinkSync(tempPath);
	return pulledEnv;
}

function buildProvisionTursoPlan({ region }) {
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

function stateSnapshot(linkDir, wouldWriteProjectJson) {
	return {
		linkDir,
		linkDirExists: existsSync(linkDir),
		wouldWriteProjectJson,
		preparedProjectJson: existsSync(
			path.join(linkDir, ".vercel", "project.json"),
		),
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
			command: "rhapsody setup check-projects --json",
			status:
				status.tools.gh.installed && status.tools.gh.authTokenPresent
					? "ready"
					: "blocked",
		},
		{
			name: "Vercel project link/create",
			command: "rhapsody setup check-projects --json",
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
			command: "rhapsody setup wait-env",
			status: status.app.env.tursoDatabaseUrlPresent ? "ready" : "ready",
		},
		{
			name: "Database migration and deploy preview",
			command: "rhapsody setup deploy-preview --dry-run",
			status:
				collectDeployPreviewBlockers(status).length === 0 ? "ready" : "blocked",
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
  setup state: ${label(status.app.setupState.exists)}${status.app.setupState.lastUpdatedAt ? ` (${status.app.setupState.lastUpdatedAt})` : ""}
  last setup command: ${status.app.setupState.lastCommand ?? "none"}

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
	const setupStatePath = getSetupStatePath();
	const setupState = readSetupState(setupStatePath);
	const ghVersion = run(["gh", "--version"]);
	const ghToken = run(["gh", "auth", "token"]);
	const vercelVersion = run(["vercel", "--version"]);
	const vercelToken =
		process.env.VERCEL_TOKEN ?? env.VERCEL_TOKEN ?? readVercelTokenFromDisk();
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
			setupState: {
				path: setupStatePath,
				exists: existsSync(setupStatePath),
				lastUpdatedAt: setupState.lastUpdatedAt ?? null,
				lastCommand: setupState.commandState?.command ?? null,
				nextAction: setupState.commandState?.nextAction ?? null,
			},
		},
		nextActions,
	};
}

function collectProjectReadiness() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const appRoot = path.join(workspaceRoot, "apps", "app");
	const statePath = getSetupStatePath();
	const env = readDotEnv(path.join(appRoot, ".env.local"));
	const vercelProjectPath = path.join(appRoot, ".vercel", "project.json");
	const vercelProject = readJson(vercelProjectPath);
	const vercelToken =
		process.env.VERCEL_TOKEN ?? env.VERCEL_TOKEN ?? readVercelTokenFromDisk();
	const blockers = [];

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
		repoSummary: null,
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
				const repo = JSON.parse(repoResult.stdout);
				github.repoReadable = true;
				github.repository = repo.nameWithOwner ?? null;
				github.repoSummary = [
					repo.nameWithOwner,
					repo.url,
					repo.defaultBranchRef?.name,
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
			"Create or link a Vercel project (`vercel link`) before setup can proceed.",
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
				"Fix blockers above, then re-run `rhapsody setup check-projects --json`.",
				"Run `rhapsody setup check-projects` for human-readable guidance.",
			]
		: [
				"GitHub and Vercel project prerequisites are ready. Run `rhapsody setup plan` to continue.",
				"Re-run `rhapsody setup check-projects --json` after any configuration changes.",
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

function readGitRemoteOriginUrl() {
	const result = run(["git", "config", "--get", "remote.origin.url"]);
	return result.ok ? result.stdout.trim() : null;
}

function normalizeGitRemoteTarget(remote) {
	const trimmed = remote?.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("http")) {
		const match = trimmed.match(/github\.com\/([^/]+\/[^/?#]+)/);
		if (match) return normalizeGithubOwnerRepo(match[1]);
		return trimmed;
	}
	if (/^git@github\.com:/.test(trimmed)) {
		const match = trimmed.match(/^git@github\.com:([^/]+\/.+)$/);
		if (match) return normalizeGithubOwnerRepo(match[1]);
		return trimmed;
	}
	return trimmed;
}

function normalizeGithubOwnerRepo(value) {
	return value.replace(/\.git$/, "");
}

function recordWaitEnvSetupState(result) {
	recordSetupState({
		command: "wait-env",
		nextAction: result.ok ? "complete" : "waiting-for-env",
		requiredEnvKeys: result.requiredEnvKeys,
		presentEnvKeys: result.presentEnvKeys,
		missingEnvKeys: result.missingEnvKeys,
		timeoutSeconds: result.timeoutSeconds,
		intervalSeconds: result.intervalSeconds,
		ok: result.ok,
	});
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

function inferTursoProjectJsonPath() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	return path.join(workspaceRoot, "apps", "app", ".vercel", "project.json");
}

function getSetupStatePath() {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	return path.join(
		workspaceRoot,
		"apps",
		"app",
		".rhapsody",
		"setup-state.json",
	);
}

function readSetupState(statePath) {
	return readJson(statePath) ?? {};
}

function recordSetupState(payload) {
	const statePath = getSetupStatePath();
	const previous = readSetupState(statePath);
	const timestamp = new Date().toISOString();
	const next = {
		...previous,
		lastUpdatedAt: timestamp,
		commandState: {
			...payload,
			updatedAt: timestamp,
		},
	};
	const stateDir = path.dirname(statePath);
	mkdirSync(stateDir, { recursive: true });
	writeFileSync(statePath, JSON.stringify(next, null, 2) + "\n", "utf8");
}

function prepareTursoLinkDirectory({ linkDir, projectJsonPath }) {
	let linkDirExisted = true;
	if (!existsSync(linkDir)) {
		mkdirSync(linkDir, { recursive: true });
		linkDirExisted = false;
	}

	let prepared = false;
	if (existsSync(projectJsonPath)) {
		const targetDir = path.join(linkDir, ".vercel");
		mkdirSync(targetDir, { recursive: true });
		copyFileSync(projectJsonPath, path.join(targetDir, "project.json"));
		prepared = true;
	}

	return {
		linkDirExisted,
		prepared,
		projectJsonTarget: path.join(linkDir, ".vercel", "project.json"),
	};
}

function runProvisionTursoApply({ commandArgv, cwd }) {
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

function runCommandFromApp({ cwd, argv }) {
	const result = spawnSync(argv[0], argv.slice(1), {
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

function run(command, options = {}) {
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

const sleepSyncState = { waitArray: new Int32Array(new SharedArrayBuffer(4)) };
function sleepSync(ms) {
	if (ms <= 0) return;
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const remaining = end - Date.now();
		Atomics.wait(sleepSyncState.waitArray, 0, 0, remaining);
	}
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
