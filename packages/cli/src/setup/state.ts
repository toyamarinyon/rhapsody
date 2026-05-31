import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

import type { SetupStateFile, SetupJourney } from "./types.js";
import { findWorkspaceRoot } from "./env.js";

const stateFilePath = (startPath: string) =>
	path.join(
		findWorkspaceRoot(startPath),
		"apps",
		"app",
		".rhapsody",
		"setup-state.json",
	);

export function getSetupStatePath(): string {
	return stateFilePath(process.cwd());
}

export function readSetupState(
	statePath: string = getSetupStatePath(),
): SetupStateFile {
	if (!existsSync(statePath)) {
		return {};
	}

	const raw = readFileSync(statePath, "utf8");
	try {
		const value = JSON.parse(raw);
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			return {};
		}
		return value as SetupStateFile;
	} catch {
		return {};
	}
}

export function recordSetupState(payload: Record<string, unknown>): void {
	const statePath = getSetupStatePath();
	const previous = readSetupState(statePath);
	const timestamp = new Date().toISOString();
	const commandState = (previous.commandState && previous.commandState) || {};

	const next: SetupStateFile = {
		...previous,
		lastUpdatedAt: timestamp,
		commandState: {
			...commandState,
			...payload,
			updatedAt: timestamp,
		},
	};

	mkdirSync(path.dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function recordSetupJourneyState(
	journeyPatch: Partial<SetupStateFile["journey"]>,
): void {
	const statePath = getSetupStatePath();
	const previous = readSetupState(statePath);
	const timestamp = new Date().toISOString();

	const next: SetupStateFile = {
		...previous,
		lastUpdatedAt: timestamp,
		journey: mergeSetupJourney(previous.journey, journeyPatch),
	};

	mkdirSync(path.dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export function summarizeSetupJourney(
	state: SetupStateFile,
): SetupJourney | null {
	const firstRun = state.journey?.firstRun;
	if (!firstRun) {
		return null;
	}
	return { firstRun };
}

function mergeSetupJourney(
	current: SetupStateFile["journey"] = {},
	patch: Partial<SetupStateFile["journey"]> = {},
): SetupStateFile["journey"] {
	if (!patch.firstRun) {
		return current;
	}
	const currentFirstRun = current?.firstRun ?? {};
	const hasNextActions = Object.prototype.hasOwnProperty.call(
		patch.firstRun,
		"nextActions",
	);
	const hasBlockers = Object.prototype.hasOwnProperty.call(
		patch.firstRun,
		"blockers",
	);
	const hasCompletedSteps = Object.prototype.hasOwnProperty.call(
		patch.firstRun,
		"completedSteps",
	);
	const nextFirstRun = {
		...currentFirstRun,
		...patch.firstRun,
		completedSteps: mergeSetupStringList(
			currentFirstRun.completedSteps,
			hasCompletedSteps ? patch.firstRun.completedSteps : undefined,
		),
		nextActions:
			patch.firstRun.nextActions !== undefined || hasNextActions
				? patch.firstRun.nextActions
				: currentFirstRun.nextActions,
		blockers:
			patch.firstRun.blockers !== undefined || hasBlockers
				? patch.firstRun.blockers
				: currentFirstRun.blockers,
	};
	if (patch.firstRun?.firstIssue !== undefined) {
		nextFirstRun.firstIssue = patch.firstRun.firstIssue;
	}

	return {
		...current,
		firstRun: nextFirstRun,
	};
}

function mergeSetupStringList(
	current: string[] = [],
	incoming: string[] = [],
): string[] {
	const values = [...current, ...incoming];
	const result: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) {
			continue;
		}
		seen.add(value);
		result.push(value);
	}
	return result;
}

export function inferTursoProjectJsonPath(): string {
	return path.join(
		findWorkspaceRoot(process.cwd()),
		"apps",
		"app",
		".vercel",
		"project.json",
	);
}

export function stateSnapshot(linkDir: string, wouldWriteProjectJson: boolean) {
	return {
		linkDir,
		linkDirExists: existsSync(linkDir),
		wouldWriteProjectJson,
		preparedProjectJson: existsSync(
			path.join(linkDir, ".vercel", "project.json"),
		),
	};
}

export function prepareTursoLinkDirectory({
	linkDir,
	projectJsonPath,
}: {
	linkDir: string;
	projectJsonPath: string;
}) {
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
