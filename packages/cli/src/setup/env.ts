import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { homedir } from "node:os";
import type {
	ClaimTokenSource,
	RootPasswordSource,
	SecretResolution,
} from "./types.js";

function readDotEnvFile(filePath: string): Record<string, string> {
	if (!existsSync(filePath)) {
		return {};
	}

	const result: Record<string, string> = {};
	const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const valueStart = trimmed.indexOf("=");
		if (valueStart === -1) continue;

		const key = trimmed.slice(0, valueStart).trim();
		let value = trimmed.slice(valueStart + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		if (key.length > 0) {
			result[key] = value;
		}
	}

	return result;
}

export function readDotEnv(filePath: string): Record<string, string> {
	return readDotEnvFile(filePath);
}

function readSingleEnvValue(filePath: string, key: string): string | null {
	const values = readDotEnvFile(filePath);
	const value = values[key];
	return value && value.length > 0 ? value : null;
}

export function resolveRootPasswordForSmoke(): SecretResolution<RootPasswordSource> | null {
	const processValue = process.env.ROOT_PASSWORD?.trim();
	if (processValue) {
		return { value: processValue, source: "process" };
	}

	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const localEnv = path.join(workspaceRoot, "apps", "app", ".env.local");
	if (!existsSync(localEnv)) {
		return null;
	}

	const envValue = readSingleEnvValue(localEnv, "ROOT_PASSWORD");
	if (!envValue) return null;

	return { value: envValue, source: ".env.local" };
}

export function resolveClaimTokenForSetup(): SecretResolution<ClaimTokenSource> | null {
	const processValue = process.env.RHAPSODY_CLAIM_TOKEN?.trim();
	if (processValue) {
		return { value: processValue, source: "process" };
	}

	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const localEnv = path.join(workspaceRoot, "apps", "app", ".env.local");
	if (!existsSync(localEnv)) {
		return null;
	}

	const envValue = readSingleEnvValue(localEnv, "RHAPSODY_CLAIM_TOKEN");
	if (!envValue) return null;

	return { value: envValue, source: ".env.local" };
}

export function readVercelTokenFromDisk(): string | null {
	const tokenPaths = [
		path.join(
			process.env.HOME ?? homedir(),
			"Library",
			"Application Support",
			"com.vercel.cli",
			"auth.json",
		),
		path.join(
			process.env.HOME ?? homedir(),
			".local",
			"share",
			"com.vercel.cli",
			"auth.json",
		),
	];

	for (const tokenPath of tokenPaths) {
		if (!existsSync(tokenPath)) {
			continue;
		}
		const values = readDotEnvFile(tokenPath);
		const token = values.token;
		if (token && token.length > 0) {
			return token;
		}
	}

	return null;
}

export function findWorkspaceRoot(startPath: string): string {
	let current = startPath;
	while (true) {
		if (
			existsSync(path.join(current, "pnpm-workspace.yaml")) &&
			existsSync(path.join(current, "apps", "app", "package.json"))
		) {
			return current;
		}
		const parent = path.dirname(current);
		if (parent === current) {
			return startPath;
		}
		current = parent;
	}
}
