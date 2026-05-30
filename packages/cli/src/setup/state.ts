import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { findWorkspaceRoot } from "./env.js";

export type SetupStateFile = {
	lastUpdatedAt?: string | null;
	commandState?: Record<string, unknown> | null;
};

export function getSetupStatePath(): string {
	return path.join(
		findWorkspaceRoot(process.cwd()),
		"apps",
		"app",
		".rhapsody",
		"setup-state.json",
	);
}

export function readSetupState(statePath?: string): SetupStateFile {
	const targetPath = statePath ?? getSetupStatePath();
	if (!existsSync(targetPath)) {
		return {};
	}
	try {
		const raw = readFileSync(targetPath, "utf8");
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
	const next: SetupStateFile = {
		...previous,
		lastUpdatedAt: timestamp,
		commandState: {
			...((previous.commandState && previous.commandState) || {}),
			...payload,
			updatedAt: timestamp,
		},
	};

	mkdirSync(path.dirname(statePath), { recursive: true });
	writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}
