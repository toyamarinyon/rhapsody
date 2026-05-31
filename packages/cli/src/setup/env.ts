import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
	ClaimTokenSource,
	ParseSetupWaitEnvResult,
	RootPasswordSource,
	SecretResolution,
	SyncCommandResult,
	WaitEnvResult,
} from "./types.js";

function readDotEnvFile(filePath: string): Record<string, string> {
	if (!existsSync(filePath)) {
		return {};
	}

	const result: Record<string, string> = {};
	for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) {
			continue;
		}

		const index = trimmed.indexOf("=");
		if (index <= 0) {
			continue;
		}

		const key = trimmed.slice(0, index).trim();
		let value = trimmed.slice(index + 1).trim();
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

function readEnvValueFromEnvLocal(
	filePath: string,
	key: string,
): string | null {
	const value = readDotEnvFile(filePath)[key];
	return value && value.length > 0 ? value : null;
}

export function readRootPasswordFromEnv(filePath: string): string | null {
	return readEnvValueFromEnvLocal(filePath, "ROOT_PASSWORD");
}

function readClaimTokenFromEnv(filePath: string): string | null {
	return readEnvValueFromEnvLocal(filePath, "RHAPSODY_CLAIM_TOKEN");
}

export function resolveRootPasswordForSmoke(): SecretResolution<RootPasswordSource> | null {
	const processValue = process.env.ROOT_PASSWORD?.trim();
	if (processValue) {
		return { value: processValue, source: "process" };
	}

	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const localEnvPath = path.join(workspaceRoot, "apps", "app", ".env.local");
	const fileValue = readRootPasswordFromEnv(localEnvPath);
	if (!fileValue) {
		return null;
	}
	return { value: fileValue, source: ".env.local" };
}

export function resolveClaimTokenForSetup(): SecretResolution<ClaimTokenSource> | null {
	const processValue = process.env.RHAPSODY_CLAIM_TOKEN?.trim();
	if (processValue) {
		return { value: processValue, source: "process" };
	}

	const workspaceRoot = findWorkspaceRoot(process.cwd());
	const localEnvPath = path.join(workspaceRoot, "apps", "app", ".env.local");
	const fileValue = readClaimTokenFromEnv(localEnvPath);
	if (!fileValue) {
		return null;
	}
	return { value: fileValue, source: ".env.local" };
}

function readVercelAuthJson(tokenPath: string): unknown {
	try {
		return JSON.parse(readFileSync(tokenPath, "utf8"));
	} catch {
		return null;
	}
}

export function readVercelTokenFromDisk(): string | null {
	const candidates = [
		path.join(
			process.env.HOME ?? "",
			"Library",
			"Application Support",
			"com.vercel.cli",
			"auth.json",
		),
		path.join(
			process.env.HOME ?? "",
			".local",
			"share",
			"com.vercel.cli",
			"auth.json",
		),
	];

	for (const candidate of candidates) {
		const values = readVercelAuthJson(candidate);
		if (typeof values !== "object" || values === null) {
			continue;
		}
		const token = (values as { token?: unknown }).token;
		if (typeof token === "string" && token.length > 0) {
			return token;
		}
	}
	return null;
}

export function gatherEnvStatus({
	status,
	requiredEnvKeys,
}: {
	status: {
		paths: {
			appRoot: string;
		};
		tools: {
			vercel: {
				installed: boolean;
				tokenPresent: boolean;
			};
		};
		app: {
			vercelProjectLink: {
				exists: boolean;
			};
		};
	};
	requiredEnvKeys: string[];
}): {
	presentEnvKeys: string[];
	missingEnvKeys: string[];
} {
	const localPath = path.join(status.paths.appRoot, ".env.local");
	const env = readDotEnv(localPath);
	const mergedEnv = { ...env };

	if (requiredEnvKeys.some((key) => !mergedEnv[key])) {
		const pulledEnv = maybeReadVercelEnv(status);
		for (const [key, value] of Object.entries(pulledEnv)) {
			if (!mergedEnv[key] && value) {
				mergedEnv[key] = value;
			}
		}
	}

	const presentEnvKeys: string[] = [];
	const missingEnvKeys: string[] = [];
	for (const key of requiredEnvKeys) {
		if (mergedEnv[key]) {
			presentEnvKeys.push(key);
		} else {
			missingEnvKeys.push(key);
		}
	}
	return { presentEnvKeys, missingEnvKeys };
}

export function maybeReadVercelEnv(status: {
	paths: {
		appRoot: string;
	};
	tools: {
		vercel: {
			installed: boolean;
			tokenPresent: boolean;
		};
	};
	app: {
		vercelProjectLink: {
			exists: boolean;
		};
	};
}): Record<string, string> {
	if (
		!status.tools.vercel.installed ||
		!status.tools.vercel.tokenPresent ||
		!status.app.vercelProjectLink.exists
	) {
		return {};
	}

	const tempPath = path.join(
		tmpdir(),
		`rhapsody-setup-env-${Date.now()}-${Math.random().toString(16).slice(2)}.env`,
	);
	const result = runCommand(
		["vercel", "env", "pull", tempPath, "--environment=development"],
		{
			cwd: status.paths.appRoot,
		},
	);
	if (!result.ok || !existsSync(tempPath)) {
		if (existsSync(tempPath)) {
			unlinkSync(tempPath);
		}
		return {};
	}

	const pulledEnv = readDotEnv(tempPath);
	unlinkSync(tempPath);
	return pulledEnv;
}

export function waitForEnv(
	params: Extract<ParseSetupWaitEnvResult, { ok: true }> & {
		statusProvider: () => {
			paths: {
				appRoot: string;
			};
			tools: {
				vercel: { installed: boolean; tokenPresent: boolean };
			};
			app: {
				vercelProjectLink: {
					exists: boolean;
				};
			};
		};
	},
): WaitEnvResult {
	const { timeoutSeconds, intervalSeconds } = params;
	const start = Date.now();
	const timeoutMs = timeoutSeconds * 1000;
	const intervalMs = intervalSeconds * 1000;
	const requiredEnvKeys = ["TURSO_DATABASE_URL", "TURSO_AUTH_TOKEN"];
	const statePath = findSetupStatePath();

	while (true) {
		const status = params.statusProvider();
		const { presentEnvKeys, missingEnvKeys } = gatherEnvStatus({
			status,
			requiredEnvKeys,
		});
		const nextActions = missingEnvKeys.length
			? [
					"Provision Turso through Vercel Marketplace or set missing keys in .env.local.",
					"Re-run `rhapsody wait-env` until all keys are available.",
				]
			: [
					"Turso env vars are available.",
					"Continue with `rhapsody plan` or next setup phase commands.",
				];
		const elapsedMs = Date.now() - start;

		if (missingEnvKeys.length === 0) {
			return {
				ok: true,
				requiredEnvKeys,
				presentEnvKeys,
				missingEnvKeys,
				timeoutSeconds,
				intervalSeconds,
				elapsedMs,
				statePath,
				nextActions,
			};
		}

		if (elapsedMs >= timeoutMs || timeoutMs === 0) {
			return {
				ok: false,
				requiredEnvKeys,
				presentEnvKeys,
				missingEnvKeys,
				timeoutSeconds,
				intervalSeconds,
				elapsedMs,
				statePath,
				nextActions,
			};
		}

		if (intervalMs > 0) {
			sleepSync(intervalMs);
		}
	}
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

function findSetupStatePath(): string {
	const workspaceRoot = findWorkspaceRoot(process.cwd());
	return path.join(
		workspaceRoot,
		"apps",
		"app",
		".rhapsody",
		"setup-state.json",
	);
}

function runCommand(
	command: string[],
	options: { cwd?: string } = {},
): SyncCommandResult {
	const result = spawnSync(command[0], command.slice(1), {
		encoding: "utf8",
		cwd: options.cwd,
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

const sleepSyncState = { waitArray: new Int32Array(new SharedArrayBuffer(4)) };
function sleepSync(ms: number) {
	if (ms <= 0) return;
	const end = Date.now() + ms;
	while (Date.now() < end) {
		const remaining = end - Date.now();
		Atomics.wait(sleepSyncState.waitArray, 0, 0, remaining);
	}
}
