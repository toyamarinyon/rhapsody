import { readFile } from "node:fs/promises";
import path from "node:path";

const RHAPSODY_CONFIG_PATH = ".rhapsody/config.toml";

export type RunnerCodexConfig = {
	model: string;
	reasoningEffort?: string;
};

export type RunnerCodexConfigLoadResult = {
	config: RunnerCodexConfig | null;
	loadedFromPath: string;
};

export class RunnerCodexConfigError extends Error {
	constructor(readonly issues: string[]) {
		super(
			`Invalid runner Codex configuration:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
		);
		this.name = "RunnerCodexConfigError";
	}
}

export async function loadRunnerCodexConfig(
	projectRoot = process.cwd(),
): Promise<RunnerCodexConfigLoadResult> {
	const configPath = path.join(projectRoot, RHAPSODY_CONFIG_PATH);

	try {
		const rawConfig = await readFile(configPath, "utf8");
		return {
			config: parseRunnerCodexConfig(rawConfig),
			loadedFromPath: configPath,
		};
	} catch (error) {
		if (error instanceof RunnerCodexConfigError) {
			throw error;
		}

		if (
			error instanceof Error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return {
				config: null,
				loadedFromPath: configPath,
			};
		}

		throw error;
	}
}

export function parseRunnerCodexConfig(
	content: string,
): RunnerCodexConfig | null {
	const lines = content.split(/\r?\n/);
	let inRunnerCodexSection = false;
	let sectionSeen = false;
	const config: Partial<RunnerCodexConfig> = {};

	for (const rawLine of lines) {
		const trimmed = stripComment(rawLine).trim();

		if (!trimmed) {
			continue;
		}

		if (trimmed === "[runner.codex]") {
			inRunnerCodexSection = true;
			sectionSeen = true;
			continue;
		}

		if (trimmed.startsWith("[[") || trimmed.startsWith("[")) {
			inRunnerCodexSection = false;
			continue;
		}

		if (!inRunnerCodexSection) {
			continue;
		}

		const assignResult = parseKeyValue(trimmed);

		if (!assignResult.ok) {
			throw new RunnerCodexConfigError([assignResult.error]);
		}

		switch (assignResult.key) {
			case "model":
				config.model = parseTomlString(assignResult.value);
				break;
			case "reasoning_effort":
				config.reasoningEffort = parseTomlString(assignResult.value);
				break;
			default:
				throw new RunnerCodexConfigError([
					`Unknown field '${assignResult.key}' in [runner.codex].`,
				]);
		}
	}

	if (!sectionSeen) {
		return null;
	}

	validateRunnerCodexConfig(config);
	return config as RunnerCodexConfig;
}

function validateRunnerCodexConfig(config: Partial<RunnerCodexConfig>) {
	const issues: string[] = [];

	if (typeof config.model !== "string" || !config.model.trim()) {
		issues.push("runner.codex.model must be a non-empty string.");
	}

	if (
		config.reasoningEffort !== undefined &&
		(typeof config.reasoningEffort !== "string" ||
			!config.reasoningEffort.trim())
	) {
		issues.push("runner.codex.reasoning_effort must be a non-empty string.");
	}

	if (issues.length > 0) {
		throw new RunnerCodexConfigError(issues);
	}
}

function stripComment(input: string): string {
	let inQuotes = false;
	let escaped = false;
	let output = "";

	for (const char of input) {
		if (!inQuotes && char === "#") {
			break;
		}

		if (char === "\\") {
			escaped = !escaped;
			output += char;
			continue;
		}

		if (!escaped && char === '"') {
			inQuotes = !inQuotes;
		}

		output += char;
		escaped = false;
	}

	return output;
}

function parseKeyValue(
	line: string,
): { ok: true; key: string; value: string } | { ok: false; error: string } {
	const keyValue = line.split("=", 2);

	if (keyValue.length !== 2) {
		return { ok: false, error: `Malformed TOML key/value pair: ${line}` };
	}

	const key = keyValue[0]?.trim();
	const value = keyValue[1]?.trim();

	if (!key || !value) {
		return { ok: false, error: `Malformed TOML key/value pair: ${line}` };
	}

	return { ok: true, key, value };
}

function parseTomlString(value: string): string {
	try {
		return JSON.parse(value);
	} catch {
		throw new RunnerCodexConfigError([
			`Expected a quoted string, got ${value}.`,
		]);
	}
}
