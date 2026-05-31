#!/usr/bin/env node
import { runSetupCommand } from "./setup/system.js";
import { runPlanCommand } from "./setup/commands/plan.js";
import {
	collectSetupStatus,
	collectProjectReadiness,
} from "./setup/commands/status.js";
import { runWaitEnvCommand } from "./setup/commands/wait-env.js";
import { runProvisionTursoCommand } from "./setup/commands/provision-turso.js";
import { runDeployPreviewCommand } from "./setup/commands/deploy-preview.js";
import { runSmokeTestCommand } from "./setup/commands/smoke-test.js";
import { runCreateFirstIssueCommand } from "./setup/commands/create-first-issue.js";
import { runFirstIssueCommand } from "./setup/commands/first-issue.js";
import { runStartAttemptCommand } from "./setup/commands/start-attempt.js";
import { runCheckProjectsCommand } from "./setup/commands/check-projects.js";
import type { LegacyExitCode } from "./setup/types.js";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const subcommand = argv[1];
const rest = argv.slice(1);
const isTopLevelHelp =
	command === "help" || command === "--help" || command === "-h";

async function dispatch(): Promise<LegacyExitCode> {
	if (isTopLevelHelp) {
		return runSetupCommand(["help", ...argv]);
	}

	if (command === "setup") {
		if (subcommand === "--json") {
			return runPlanCommand(rest);
		}
		if (subcommand === undefined || subcommand === "--yes") {
			if (subcommand === "--yes" && !argv.includes("--json")) {
				console.log(
					"`rhapsody setup --yes` is currently non-mutating. Setup orchestration is not yet implemented; this command shows the setup plan and diagnostics only.",
				);
			}
			return runPlanCommand(rest);
		}

		if (subcommand === "--help" || subcommand === "-h") {
			return runSetupCommand(["setup", "--help"]);
		}

		console.error(`Unknown top-level setup subcommand: ${subcommand}`);
		console.error(
			"`rhapsody setup` now runs the top-level setup flow directly.",
		);
		console.error("Run `rhapsody --help` for available commands.");
		return 1;
	}

	if (command === "doctor") {
		if (
			subcommand === "--help" ||
			subcommand === "-h" ||
			subcommand === "help"
		) {
			return runSetupCommand(["doctor", "--help"]);
		}
		return runDoctorCommand(rest);
	}

	if (command === "plan") {
		if (
			subcommand === "--help" ||
			subcommand === "-h" ||
			subcommand === "help"
		) {
			return runSetupCommand(["plan", "--help"]);
		}
		return runPlanCommand(rest);
	}

	if (command === "check-projects") {
		return runCheckProjectsCommand(rest);
	}

	if (command === "wait-env") {
		return runWaitEnvCommand(rest);
	}

	if (command === "provision-turso") {
		return runProvisionTursoCommand(rest);
	}

	if (command === "deploy-preview") {
		return runDeployPreviewCommand(rest);
	}

	if (command === "smoke-test") {
		return runSmokeTestCommand(rest);
	}

	if (command === "create-first-issue") {
		return runCreateFirstIssueCommand(rest);
	}

	if (command === "first-issue") {
		return runFirstIssueCommand(rest);
	}

	if (command === "start-attempt") {
		return runStartAttemptCommand(rest);
	}

	return runSetupCommand(argv);
}

const exitCode = await dispatch();
process.exit(exitCode);

async function runDoctorCommand(args: string[]): Promise<LegacyExitCode> {
	const status = collectSetupStatus();
	const projects = collectProjectReadiness();
	const includeJson = args.includes("--json");

	const normalizeTopLevelNextActions = (nextActions: string[]): string[] =>
		nextActions.map((action) =>
			action
				.replace(
					/`rhapsody setup check-projects --json`/g,
					"`rhapsody check-projects --json`",
				)
				.replace(
					/`rhapsody setup check-projects`/g,
					"`rhapsody check-projects`",
				)
				.replace(/`rhapsody setup plan`/g, "`rhapsody plan`"),
		);

	if (includeJson) {
		const blockers = [...projects.blockers];
		const nextActions = [
			...normalizeTopLevelNextActions(status.nextActions),
			...normalizeTopLevelNextActions(projects.nextActions),
		];
		const ok = status.ok && projects.ok;
		console.log(
			JSON.stringify(
				{
					ok,
					status,
					projects,
					blockers,
					nextActions,
				},
				null,
				2,
			),
		);
		return ok ? 0 : 1;
	}

	console.log("Rhapsody doctor");
	console.log("");
	console.log(`Workspace: ${status.paths.workspaceRoot}`);
	console.log(`Status: ${status.ok ? "ok" : "blocked"}`);
	console.log("Readiness blockers:");
	if (projects.blockers.length === 0) {
		console.log("  - none");
	} else {
		for (const blocker of projects.blockers) {
			console.log(`  - ${blocker}`);
		}
	}
	if (status.nextActions.length > 0) {
		console.log("Next actions:");
		for (const nextAction of normalizeTopLevelNextActions(
			projects.nextActions,
		)) {
			console.log(`  - ${nextAction}`);
		}
	}

	return status.ok && projects.ok ? 0 : 1;
}
