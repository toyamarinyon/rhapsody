#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";

import { buildProvisionTursoPlan, inferTursoLinkContext } from "../vercel.js";
import {
	inferTursoProjectJsonPath,
	prepareTursoLinkDirectory,
	stateSnapshot,
	recordSetupState,
} from "../state.js";
import { runProvisionTursoApply } from "../vercel.js";
import type {
	ParseSetupProvisionTursoResult,
	ParseResult,
	Region,
	LegacyExitCode,
} from "../types.js";

export async function runProvisionTursoCommand(
	args: string[],
): Promise<LegacyExitCode> {
	const parse = parseProvisionTursoArgs(args);
	if (parse.ok === false) {
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
		printProvisionTurso({ json: parse.json, plan });
		process.exit(plan.ok ? 0 : 1);
	}

	recordSetupState({
		command: "provision-turso",
		mode: "apply",
		region: parse.region,
		applyConfirmationProvided: parse.yes,
		before: stateSnapshot(plan.linkDir, plan.wouldWriteProjectJson),
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

function parseProvisionTursoArgs(
	args: string[],
): ParseSetupProvisionTursoResult {
	const parsedRegion = parseRegionFlag(args);
	if (isParseFailure(parsedRegion)) {
		return { ok: false, error: parsedRegion.error };
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

function parseRegionFlag(args: string[]): ParseResult<{ region: Region }> {
	const allowedRegions = new Set([
		"iad1",
		"cle1",
		"pdx1",
		"dub1",
		"bom1",
		"hnd1",
	]);
	let region: Region = "hnd1";
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
			region = value as Region;
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
			region = value as Region;
			continue;
		}
	}

	return {
		ok: true,
		region,
	};
}

function isParseFailure<TData>(
	value: ParseResult<TData>,
): value is { ok: false; error: string } {
	return value.ok === false;
}

function printProvisionTurso({
	json,
	plan,
}: {
	json: boolean;
	plan: ReturnType<typeof buildProvisionTursoPlan>;
}) {
	if (json) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	console.log(`Rhapsody setup provision-turso (dry-run)`);
	console.log(`\nNo resources were created in dry-run mode.`);
	console.log(`\nRegion: ${plan.region}`);
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
