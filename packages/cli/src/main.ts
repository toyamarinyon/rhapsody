#!/usr/bin/env node
import { runSetupCommand } from "./setup/system.js";
import { runStatusCommand } from "./setup/commands/status.js";
import { runPlanCommand } from "./setup/commands/plan.js";
import { runCheckProjectsCommand } from "./setup/commands/check-projects.js";
import { runWaitEnvCommand } from "./setup/commands/wait-env.js";
import { runProvisionTursoCommand } from "./setup/commands/provision-turso.js";
import { runDeployPreviewCommand } from "./setup/commands/deploy-preview.js";
import { runSmokeTestCommand } from "./setup/commands/smoke-test.js";
import { runCreateFirstIssueCommand } from "./setup/commands/create-first-issue.js";
import { runFirstIssueCommand } from "./setup/commands/first-issue.js";
import { runStartAttemptCommand } from "./setup/commands/start-attempt.js";
import type { LegacyExitCode } from "./setup/types.js";

const argv = process.argv.slice(2);
const command = argv[0] ?? "help";
const subcommand = argv[1];
const rest = argv.slice(2);

async function dispatch(): Promise<LegacyExitCode> {
	if (command === "setup") {
		switch (subcommand) {
			case "status":
				return runStatusCommand(rest);
			case "plan":
				return runPlanCommand(rest);
			case "check-projects":
				return runCheckProjectsCommand(rest);
			case "wait-env":
				return runWaitEnvCommand(rest);
			case "provision-turso":
				return runProvisionTursoCommand(rest);
			case "deploy-preview":
				return runDeployPreviewCommand(rest);
			case "smoke-test":
				return runSmokeTestCommand(rest);
			case "create-first-issue":
				return runCreateFirstIssueCommand(rest);
			case "first-issue":
				return runFirstIssueCommand(rest);
			case "start-attempt":
				return runStartAttemptCommand(rest);
			case undefined:
				return runSetupCommand(["setup"]);
			case "--help":
			case "-h":
				return runSetupCommand(["setup", subcommand]);
			default:
				return runSetupCommand(argv);
		}
	}

	return runSetupCommand(argv);
}

const exitCode = await dispatch();
process.exit(exitCode);
