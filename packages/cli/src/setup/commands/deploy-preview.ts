#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import {
	buildDeployPreviewPlan,
	collectDeployPreviewBlockers,
} from "../vercel.js";
import { collectSetupStatus, printSetupStatus } from "./status.js";
import { recordSetupState } from "../state.js";
import type {
	CommandMode,
	DeployPreviewPlanResult,
	ParseSetupDeployPreviewResult,
	RunResult,
	LegacyExitCode,
} from "../types.js";

export async function runDeployPreviewCommand(
	args: string[],
): Promise<LegacyExitCode> {
	const parse = parseDeployPreviewArgs(args);
	if (parse.ok === false) {
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
			"rhapsody deploy-preview requires confirmation in apply mode. Pass --yes to execute.",
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
					"Re-run `rhapsody deploy-preview --yes` after resolving blocking issues.",
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
				signal: step.signal,
			})),
		},
	});
	process.exit(ok ? 0 : 1);
}

function parseDeployPreviewArgs(args: string[]): ParseSetupDeployPreviewResult {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error: "Usage: rhapsody deploy-preview (--dry-run|--yes) [--json]",
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

function printDeployPreviewPlan({
	json,
	mode,
	plan,
}: {
	json: boolean;
	mode: CommandMode;
	plan: DeployPreviewPlanResult & {
		appRoot: string;
		statePath: string;
		plannedCommands: string[];
		appliedSteps?: Array<{
			command: string;
			exitCode: number;
			signal?: string | null;
		}>;
	};
}) {
	if (json) {
		const payload: {
			ok: boolean;
			mode: CommandMode;
			appRoot: string;
			statePath: string;
			plannedCommands: string[];
			blockers: string[];
			nextActions: string[];
			appliedSteps?: Array<{
				command: string;
				exitCode: number;
				signal?: string | null;
			}>;
		} = {
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

function runCommandFromApp({
	cwd,
	argv,
}: {
	cwd: string;
	argv: string[];
}): RunResult {
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
