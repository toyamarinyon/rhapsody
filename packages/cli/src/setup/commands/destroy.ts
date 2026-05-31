#!/usr/bin/env node
import { existsSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import {
	findWorkspaceRoot,
	readDotEnv,
	readVercelTokenFromDisk,
} from "../env.js";
import type { JsonObject, LegacyExitCode, ParseResult } from "../types.js";

const VERCEL_API = "https://api.vercel.com";

type DestroyPlan = {
	ok: boolean;
	mode: "dry-run" | "apply";
	projectName: string | null;
	projectId: string | null;
	orgId: string | null;
	projectJsonPath: string;
	tursoResources: Array<{ id: string; name: string | null }>;
	blockers: string[];
	nextActions: string[];
};

type DestroyApplyResult = DestroyPlan & {
	removedTursoResources: Array<{ id: string; name: string | null }>;
	projectDeleted: boolean;
	localProjectJsonRemoved: boolean;
};

export async function runDestroyCommand(
	args: string[],
): Promise<LegacyExitCode> {
	const parse = parseDestroyArgs(args);
	if (!parse.ok) {
		if (parse.error === "help requested") {
			printDestroyHelp();
			return 0;
		}
		console.error(parse.error);
		return 1;
	}

	const plan = await buildDestroyPlan({ projectName: parse.projectName });
	if (parse.dryRun || !parse.yes || !plan.ok) {
		printDestroyResult({
			json: parse.json,
			result: {
				...plan,
				mode: parse.dryRun ? "dry-run" : "apply",
				blockers:
					!parse.dryRun && !parse.yes && plan.ok
						? [
								"Destroy requires explicit confirmation. Re-run with --yes to delete remote resources.",
							]
						: plan.blockers,
				nextActions:
					!parse.dryRun && !parse.yes && plan.ok
						? [
								`Run \`rhapsody destroy --project-name ${plan.projectName} --yes\` to delete the Vercel project and linked Turso resources.`,
							]
						: plan.nextActions,
			},
		});
		return parse.dryRun || plan.ok ? 0 : 1;
	}

	const result = await applyDestroy(plan);
	printDestroyResult({ json: parse.json, result });
	return result.ok ? 0 : 1;
}

function parseDestroyArgs(args: string[]): ParseResult<{
	yes: boolean;
	dryRun: boolean;
	json: boolean;
	projectName: string | null;
}> {
	if (args.includes("--help") || args.includes("-h")) {
		return { ok: false, error: "help requested" };
	}

	let projectName: string | null = null;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--yes" || arg === "--dry-run" || arg === "--json") {
			continue;
		}
		if (arg === "--project-name") {
			const value = args[index + 1];
			if (!value || value.startsWith("-")) {
				return { ok: false, error: "Missing value for --project-name" };
			}
			projectName = value;
			index++;
			continue;
		}
		if (arg.startsWith("--project-name=")) {
			const value = arg.slice("--project-name=".length).trim();
			if (!value) {
				return { ok: false, error: "Missing value for --project-name" };
			}
			projectName = value;
			continue;
		}
		return {
			ok: false,
			error:
				"Usage: rhapsody destroy [--dry-run|--yes] [--json] [--project-name <name>]",
		};
	}

	return {
		ok: true,
		yes: args.includes("--yes"),
		dryRun: args.includes("--dry-run"),
		json: args.includes("--json"),
		projectName,
	};
}

async function buildDestroyPlan({
	projectName,
}: {
	projectName: string | null;
}): Promise<DestroyPlan> {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const appRoot = path.join(workspaceRoot, "apps", "app");
	const projectJsonPath = path.join(appRoot, ".vercel", "project.json");
	const projectJson = readJson(projectJsonPath);
	const resolvedProjectName =
		projectName ??
		(typeof projectJson?.projectName === "string"
			? projectJson.projectName
			: null);
	const projectId =
		typeof projectJson?.projectId === "string" ? projectJson.projectId : null;
	const orgId =
		typeof projectJson?.orgId === "string" ? projectJson.orgId : null;
	const blockers: string[] = [];

	if (!existsSync(appRoot)) {
		blockers.push("Run this command from the Rhapsody repository root.");
	}
	if (!resolvedProjectName) {
		blockers.push(
			"Cannot infer Vercel project name. Pass --project-name or run from a linked Rhapsody checkout.",
		);
	}
	const token = resolveVercelToken(appRoot);
	if (!token) {
		blockers.push("Run `vercel login` or set VERCEL_TOKEN before destroy.");
	}

	let tursoResources: Array<{ id: string; name: string | null }> = [];
	if (resolvedProjectName && token) {
		const list = listTursoResources({
			projectName: resolvedProjectName,
			token,
		});
		if (!list.ok) {
			blockers.push(list.error);
		} else {
			tursoResources = list.resources;
		}
	}

	return {
		ok: blockers.length === 0,
		mode: "dry-run",
		projectName: resolvedProjectName,
		projectId,
		orgId,
		projectJsonPath,
		tursoResources,
		blockers,
		nextActions:
			blockers.length > 0
				? ["Fix blockers above and rerun `rhapsody destroy --dry-run`."]
				: [
						`Run \`rhapsody destroy --project-name ${resolvedProjectName} --yes\` to delete the Vercel project and linked Turso resources.`,
					],
	};
}

async function applyDestroy(plan: DestroyPlan): Promise<DestroyApplyResult> {
	const blockers: string[] = [];
	const removedTursoResources: Array<{ id: string; name: string | null }> = [];
	const token = resolveVercelToken(
		path.dirname(path.dirname(plan.projectJsonPath)),
	);
	if (!token) {
		return {
			...plan,
			ok: false,
			mode: "apply",
			removedTursoResources,
			projectDeleted: false,
			localProjectJsonRemoved: false,
			blockers: ["Run `vercel login` or set VERCEL_TOKEN before destroy."],
			nextActions: ["Authenticate with Vercel and rerun destroy."],
		};
	}

	for (const resource of plan.tursoResources) {
		const removed = removeTursoResource({ resourceId: resource.id, token });
		if (!removed.ok) {
			blockers.push(removed.error);
			continue;
		}
		removedTursoResources.push(resource);
	}

	let projectDeleted = false;
	if (blockers.length === 0 && plan.projectName) {
		const deleted = await deleteVercelProject({
			project: plan.projectId ?? plan.projectName,
			teamId: plan.orgId,
			token,
		});
		if (!deleted.ok) {
			blockers.push(deleted.error);
		} else {
			projectDeleted = true;
		}
	}

	let localProjectJsonRemoved = false;
	if (projectDeleted && existsSync(plan.projectJsonPath)) {
		rmSync(plan.projectJsonPath);
		localProjectJsonRemoved = true;
	}

	return {
		...plan,
		ok: blockers.length === 0,
		mode: "apply",
		removedTursoResources,
		projectDeleted,
		localProjectJsonRemoved,
		blockers,
		nextActions:
			blockers.length > 0
				? ["Fix blockers above and rerun `rhapsody destroy --yes`."]
				: ["Destroy completed."],
	};
}

function listTursoResources({
	projectName,
	token,
}: {
	projectName: string;
	token: string;
}):
	| { ok: true; resources: Array<{ id: string; name: string | null }> }
	| {
			ok: false;
			error: string;
	  } {
	const result = spawnSync(
		"vercel",
		[
			"integration",
			"list",
			projectName,
			"--format=json",
			"--integration",
			"tursocloud",
			"--token",
			token,
		],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) {
		return {
			ok: false,
			error: `Failed to list Turso resources: ${result.stderr || result.stdout}`,
		};
	}

	try {
		const parsed = JSON.parse(result.stdout) as { resources?: unknown };
		const resources = Array.isArray(parsed.resources)
			? parsed.resources.flatMap((resource) => {
					if (typeof resource !== "object" || resource === null) {
						return [];
					}
					const record = resource as JsonObject;
					const id =
						typeof record.id === "string"
							? record.id
							: typeof record.resourceId === "string"
								? record.resourceId
								: null;
					if (!id) {
						return [];
					}
					return [
						{
							id,
							name: typeof record.name === "string" ? record.name : null,
						},
					];
				})
			: [];
		return { ok: true, resources };
	} catch {
		return {
			ok: false,
			error: `Failed to parse Turso resource list: ${result.stdout}`,
		};
	}
}

function removeTursoResource({
	resourceId,
	token,
}: {
	resourceId: string;
	token: string;
}): { ok: true } | { ok: false; error: string } {
	const result = spawnSync(
		"vercel",
		[
			"integration-resource",
			"remove",
			resourceId,
			"--disconnect-all",
			"--yes",
			"--format=json",
			"--token",
			token,
		],
		{ encoding: "utf8", stdio: "pipe" },
	);
	if (result.status !== 0) {
		return {
			ok: false,
			error: `Failed to remove Turso resource ${resourceId}: ${result.stderr || result.stdout}`,
		};
	}
	return { ok: true };
}

async function deleteVercelProject({
	project,
	teamId,
	token,
}: {
	project: string;
	teamId: string | null;
	token: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const query = teamId ? `?teamId=${encodeURIComponent(teamId)}` : "";
	let response: Response;
	try {
		response = await fetch(
			`${VERCEL_API}/v9/projects/${encodeURIComponent(project)}${query}`,
			{
				method: "DELETE",
				headers: { Authorization: `Bearer ${token}` },
			},
		);
	} catch (error) {
		return {
			ok: false,
			error: `Network error while deleting Vercel project: ${String(error)}`,
		};
	}

	if (response.status === 404) {
		return { ok: true };
	}
	if (!response.ok) {
		return {
			ok: false,
			error: `Failed to delete Vercel project ${project}: ${response.status} ${await response.text()}`,
		};
	}
	return { ok: true };
}

function resolveVercelToken(appRoot: string): string | null {
	const envToken = process.env.VERCEL_TOKEN?.trim();
	if (envToken) {
		return envToken;
	}
	const appEnv = readDotEnv(path.join(appRoot, ".env.local"));
	if (typeof appEnv.VERCEL_TOKEN === "string" && appEnv.VERCEL_TOKEN.trim()) {
		return appEnv.VERCEL_TOKEN.trim();
	}
	return readVercelTokenFromDisk();
}

function readJson(filePath: string): JsonObject | null {
	if (!existsSync(filePath)) {
		return null;
	}
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		return typeof parsed === "object" && parsed !== null
			? (parsed as JsonObject)
			: null;
	} catch {
		return null;
	}
}

function printDestroyResult({
	json,
	result,
}: {
	json: boolean;
	result: DestroyPlan | DestroyApplyResult;
}) {
	if (json) {
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	console.log("Rhapsody destroy");
	console.log(`Mode: ${result.mode}`);
	console.log(`Project: ${result.projectName ?? "unknown"}`);
	console.log(`Turso resources: ${result.tursoResources.length}`);
	if ("projectDeleted" in result) {
		console.log(`Project deleted: ${result.projectDeleted ? "yes" : "no"}`);
		console.log(
			`Local project link removed: ${
				result.localProjectJsonRemoved ? "yes" : "no"
			}`,
		);
	}

	if (result.blockers.length > 0) {
		console.log("Blockers:");
		for (const blocker of result.blockers) {
			console.log(`  - ${blocker.trim()}`);
		}
	} else {
		console.log("Blockers: none");
	}

	console.log("Next actions:");
	for (const action of result.nextActions) {
		console.log(`  - ${action}`);
	}
}

function printDestroyHelp() {
	console.log(`Usage:
  rhapsody destroy [--dry-run|--yes] [--json] [--project-name <name>]

Delete the linked Vercel project and any Turso resources connected to it.
	Pass \`--dry-run\` to inspect what would be deleted.
	Pass \`--yes\` to delete remote resources.
	Pass \`--project-name\` to target a specific Vercel project.
`);
}
