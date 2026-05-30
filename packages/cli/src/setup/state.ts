import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";

import type { SetupStateFile } from "./types.js";
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
