#!/usr/bin/env node
import { spawnSync } from "node:child_process";

import { getSetupStatePath, recordSetupState } from "../state.js";
import {
	inferTursoProjectJsonPath,
	prepareTursoLinkDirectory,
} from "../state.js";
import { waitForEnv } from "../env.js";
import {
	buildDeployPreviewPlan,
	buildProvisionTursoPlan,
	runProvisionTursoApply,
} from "../vercel.js";
import { collectProjectReadiness, collectSetupStatus } from "./status.js";
import type { LegacyExitCode, ParseResult } from "../types.js";

type SetupExecution = {
	ok: boolean;
	phase: string;
	currentStep: string;
	steps: string[];
	blockers: string[];
	nextActions: string[];
	statePath: string;
};

export async function runSetupOrchestratorCommand(
	args: string[],
): Promise<LegacyExitCode> {
	const parse = parseSetupArgs(args);
	if (!parse.ok) {
		if (parse.help) {
			console.log(`Usage:
  rhapsody setup [--yes] [--json]

Run setup end-to-end until the next required manual step.
`);
			return 0;
		}
		console.error(parse.error);
		return 1;
	}

	const result = runSetupOrchestrator({ yes: parse.yes });
	if (parse.json) {
		console.log(JSON.stringify(result, null, 2));
		return result.ok ? 0 : 1;
	}

	console.log("Rhapsody setup");
	console.log(`Current step: ${result.currentStep}`);
	console.log(`State path: ${result.statePath}`);

	if (result.blockers.length > 0) {
		console.log("Blockers:");
		for (const blocker of result.blockers) {
			console.log(`  - ${blocker}`);
		}
	} else {
		console.log("Blockers: none");
	}

	console.log("Next actions:");
	for (const action of result.nextActions) {
		console.log(`  - ${action}`);
	}

	return result.ok ? 0 : 1;
}

function parseSetupArgs(args: string[]): ParseResult<{
	yes: boolean;
	json: boolean;
}> & { help?: true } {
	if (args.includes("--help") || args.includes("-h")) {
		return { ok: false, help: true, error: "help requested" };
	}

	const allowed = new Set(["--yes", "--json"]);
	for (const arg of args) {
		if (arg === "setup") {
			continue;
		}
		if (!allowed.has(arg)) {
			return {
				ok: false,
				error: `Unsupported argument: ${arg}
Use: rhapsody setup [--yes] [--json]`,
			};
		}
	}

	return {
		ok: true,
		yes: args.includes("--yes"),
		json: args.includes("--json"),
	};
}

function runSetupOrchestrator({ yes }: { yes: boolean }): SetupExecution {
	const statePath = getSetupStatePath();
	const steps: string[] = [];

	steps.push("collect-status");
	const status = collectSetupStatus();
	const readiness = collectProjectReadiness();
	const initialBlockers = dedupe(
		normalizeSetupActions([
			...status.nextActions,
			...readiness.blockers,
		]).filter(
			(item) => !item.includes("Local setup prerequisites look present"),
		),
	);

	recordSetupState({
		command: "setup",
		currentStep: "collect-status",
		nextAction: initialBlockers.length > 0 ? "blocked" : "ready",
		steps,
		blockers: initialBlockers,
		nextActions:
			initialBlockers.length > 0
				? initialBlockers
				: ["Status checks passed, continuing setup."],
	});

	if (initialBlockers.length > 0) {
		return {
			ok: false,
			phase: "preflight",
			currentStep: "collect-status",
			steps,
			blockers: initialBlockers,
			nextActions: [
				"Fix blockers above and rerun `rhapsody setup`.",
				"Run `rhapsody doctor --json` for full diagnostic details.",
			],
			statePath,
		};
	}

	steps.push("provision-turso");
	const provisionResult = runProvisionTursoStep({ yes });
	if (!provisionResult.ok) {
		return {
			ok: false,
			phase: "provision-turso",
			currentStep: "provision-turso",
			steps,
			blockers: provisionResult.blockers,
			nextActions: provisionResult.nextActions,
			statePath,
		};
	}

	steps.push("wait-env");
	const waitResult = runWaitEnvStep(yes);
	if (!waitResult.ok) {
		return {
			ok: false,
			phase: "wait-env",
			currentStep: "wait-env",
			steps,
			blockers: waitResult.blockers,
			nextActions: waitResult.nextActions,
			statePath,
		};
	}

	steps.push("deploy-preview");
	const deployResult = runDeployPreviewStep({ yes });
	if (!deployResult.ok) {
		return {
			ok: false,
			phase: "deploy-preview",
			currentStep: "deploy-preview",
			steps,
			blockers: deployResult.blockers,
			nextActions: deployResult.nextActions,
			statePath,
		};
	}

	const nextActions = [
		"Run `rhapsody smoke-test --url <preview-url>` to verify the preview deployment.",
		"Run `rhapsody first-issue --url <preview-url> --issue-number <issue-number> --use-root-password` for the first issue handoff.",
		"Run `rhapsody start-attempt --url <preview-url> --run-id <run-id> --attempt-id <attempt-id> --use-root-password` to start the first run attempt.",
	];
	recordSetupState({
		command: "setup",
		currentStep: "smoke-test",
		nextAction: "blocked",
		steps,
		blockers: [],
		nextActions,
	});

	return {
		ok: false,
		phase: "await-user-input",
		currentStep: "smoke-test",
		steps,
		blockers: [],
		nextActions,
		statePath,
	};
}

function runProvisionTursoStep({ yes }: { yes: boolean }): {
	ok: boolean;
	blockers: string[];
	nextActions: string[];
} {
	const status = collectSetupStatus();
	if (
		status.app.env.tursoDatabaseUrlPresent &&
		status.app.env.tursoAuthTokenPresent
	) {
		return { ok: true, blockers: [], nextActions: [] };
	}

	const plan = buildProvisionTursoPlan({ region: "hnd1" });
	if (!yes) {
		return {
			ok: false,
			blockers: ["Turso env vars are not present in apps/app/.env.local yet."],
			nextActions: ["Run `rhapsody provision-turso --yes` to provision Turso."],
		};
	}

	if (!plan.applyReady) {
		return {
			ok: false,
			blockers: ["Vercel project metadata is not available for provisioning."],
			nextActions: [
				"Run `rhapsody check-projects` to fix project link metadata before provisioning.",
				"Then re-run `rhapsody setup --yes`.",
			],
		};
	}

	const prepared = prepareTursoLinkDirectory({
		linkDir: plan.linkDir,
		projectJsonPath: inferTursoProjectJsonPath(),
	});

	const result = runProvisionTursoApply({
		commandArgv: plan.commandArgv,
		cwd: plan.linkDir,
	});

	recordSetupState({
		command: "provision-turso",
		mode: "apply",
		region: plan.region,
		nextAction: result.ok ? "complete" : "failed",
		preparedDirectory: plan.linkDir,
		preparedProjectJson: prepared.prepared,
		exitCode: result.exitCode,
		blockers: result.ok ? [] : ["Turso provisioning command failed."],
		nextActions: result.ok
			? ["Turso provisioning completed."]
			: ["Fix the command output and rerun `rhapsody setup --yes`."],
	});

	if (!result.ok) {
		return {
			ok: false,
			blockers: ["Turso provisioning command failed."],
			nextActions: ["Fix the command output and rerun `rhapsody setup --yes`."],
		};
	}

	return {
		ok: true,
		blockers: [],
		nextActions: ["Turso env vars provisioning command finished."],
	};
}

function runWaitEnvStep(yes: boolean): {
	ok: boolean;
	blockers: string[];
	nextActions: string[];
} {
	const timeoutSeconds = yes ? 30 : 0;
	const result = waitForEnv({
		ok: true,
		json: false,
		timeoutSeconds,
		intervalSeconds: Math.min(3, Math.max(1, timeoutSeconds)),
		statusProvider: collectSetupStatus,
	});

	recordSetupState({
		command: "wait-env",
		currentStep: "wait-env",
		nextAction: result.ok ? "complete" : "waiting-for-env",
		requiredEnvKeys: result.requiredEnvKeys,
		presentEnvKeys: result.presentEnvKeys,
		missingEnvKeys: result.missingEnvKeys,
		blockers: result.ok ? [] : ["Turso env vars are not fully available yet."],
		nextActions: result.nextActions,
	});

	return {
		ok: result.ok,
		blockers: result.ok ? [] : ["Turso env vars are not fully available yet."],
		nextActions: result.nextActions,
	};
}

function runDeployPreviewStep({ yes }: { yes: boolean }): {
	ok: boolean;
	blockers: string[];
	nextActions: string[];
} {
	const status = collectSetupStatus();
	const plan = buildDeployPreviewPlan({ status });

	if (plan.blockers.length > 0) {
		return {
			ok: false,
			blockers: plan.blockers,
			nextActions: plan.nextActions,
		};
	}

	if (!yes) {
		return {
			ok: false,
			blockers: [],
			nextActions: [
				"Run `rhapsody deploy-preview --yes` to run preview migration and deploy.",
			],
		};
	}

	for (const step of plan.commandPlan) {
		const result = runCommandFromApp({
			cwd: plan.appRoot,
			argv: step.argv,
		});
		if (!result.ok) {
			return {
				ok: false,
				blockers: ["deploy-preview command failed."],
				nextActions: [
					"Fix blockers above and rerun `rhapsody deploy-preview --yes`.",
					"Then re-run `rhapsody setup --yes`.",
				],
			};
		}
	}

	recordSetupState({
		command: "deploy-preview",
		currentStep: "deploy-preview",
		nextAction: "complete",
		nextActions: ["Deploy preview completed."],
		commandCount: plan.commandPlan.length,
	});

	return { ok: true, blockers: [], nextActions: ["Deploy preview completed."] };
}

function runCommandFromApp({ cwd, argv }: { cwd: string; argv: string[] }): {
	ok: boolean;
	exitCode: number;
	signal: string | null;
} {
	const result = spawnSync(argv[0], argv.slice(1), {
		cwd,
		encoding: "utf8",
		stdio: "inherit",
	});
	return {
		ok: result.status === 0,
		exitCode: result.status ?? 1,
		signal: result.signal,
	};
}

function normalizeSetupActions(values: string[]): string[] {
	return values
		.map((value) =>
			value
				.replace(
					/`rhapsody setup check-projects --json`/g,
					"`rhapsody check-projects --json`",
				)
				.replace(
					/`rhapsody setup check-projects`/g,
					"`rhapsody check-projects`",
				)
				.replace(/`rhapsody setup plan`/g, "`rhapsody plan`"),
		)
		.filter(Boolean);
}

function dedupe(values: string[]): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			continue;
		}
		seen.add(value);
		out.push(value);
	}
	return out;
}
