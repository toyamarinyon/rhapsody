import { readFile } from "node:fs/promises";
import path from "node:path";

const RHAPSODY_REPAIR_CONFIG_PATH = ".rhapsody/config.toml";

export type RepairFormatCheckRule = {
	workflowPath: string;
	jobName: string;
	stepNames: string[];
};

export type RepairPolicy = {
	format_checks: RepairFormatCheckRule[];
};

export type RepairConfig = {
	repair: RepairPolicy;
};

export type RepairConfigLoadResult = {
	config: RepairConfig;
	loadedFromPath: string;
	errors: string[];
};

export class RepairConfigError extends Error {
	constructor(readonly issues: string[]) {
		super(
			`Invalid repair config:\n${issues.map((issue) => `- ${issue}`).join("\n")}`,
		);
		this.name = "RepairConfigError";
	}
}

export async function loadRepairConfig(
	projectRoot = process.cwd(),
): Promise<RepairConfigLoadResult> {
	const configPath = path.join(projectRoot, RHAPSODY_REPAIR_CONFIG_PATH);
	const errors: string[] = [];

	try {
		const rawConfig = await readFile(configPath, "utf8");
		const config = parseRepairConfig(rawConfig);
		validateRepairConfig(config);
		return { config, loadedFromPath: configPath, errors };
	} catch (error) {
		if (error instanceof RepairConfigError) {
			return {
				config: cloneDefaultRepairConfig(),
				loadedFromPath: configPath,
				errors: [error.message],
			};
		}

		if (
			error instanceof Error &&
			(error as NodeJS.ErrnoException).code === "ENOENT"
		) {
			return {
				config: cloneDefaultRepairConfig(),
				loadedFromPath: configPath,
				errors: [
					"Repair config file is missing; using check-name fallback heuristics.",
				],
			};
		}

		throw error;
	}
}

export function parseRepairConfig(content: string): RepairConfig {
	const lines = content.split(/\r?\n/);
	const config = cloneDefaultRepairConfig();
	let section: "repair" | "repair.format_checks" | null = null;
	let sawRepairSection = false;

	for (const rawLine of lines) {
		const trimmed = stripComment(rawLine).trim();

		if (!trimmed) {
			continue;
		}

		if (trimmed === "[repair]") {
			section = "repair";
			sawRepairSection = true;
			continue;
		}

		if (trimmed === "[[repair.format_checks]]") {
			if (!sawRepairSection) {
				throw new RepairConfigError([
					"[[repair.format_checks]] must appear inside a [repair] section.",
				]);
			}

			section = "repair.format_checks";
			config.repair.format_checks.push({
				workflowPath: "",
				jobName: "",
				stepNames: [],
			});
			continue;
		}

		if (trimmed.startsWith("[[") || trimmed.startsWith("[")) {
			section = null;
			continue;
		}

		if (!section) {
			continue;
		}

		const assignResult = parseKeyValue(trimmed);
		if (!assignResult.ok) {
			throw new RepairConfigError([assignResult.error]);
		}

		if (section === "repair") {
			throw new RepairConfigError([
				`Unknown field '${assignResult.key}' in [repair].`,
			]);
		}

		const rule = config.repair.format_checks.at(-1);
		if (!rule) {
			throw new RepairConfigError([
				"[[repair.format_checks]] must declare a rule before fields.",
			]);
		}

		switch (assignResult.key) {
			case "workflow_path":
				rule.workflowPath = parseTomlString(assignResult.value);
				break;
			case "job_name":
				rule.jobName = parseTomlString(assignResult.value);
				break;
			case "step_names":
				rule.stepNames = parseStringArray(assignResult.value);
				break;
			default:
				throw new RepairConfigError([
					`Unknown field '${assignResult.key}' in repair format check rule.`,
				]);
		}
	}

	return config;
}

function validateRepairConfig(config: RepairConfig) {
	const issues: string[] = [];

	if (!Array.isArray(config.repair.format_checks)) {
		issues.push("repair.format_checks must be an array.");
	}

	for (const [index, rule] of config.repair.format_checks.entries()) {
		if (!rule.workflowPath.trim()) {
			issues.push(
				`repair.format_checks[${index}].workflowPath must be a non-empty string.`,
			);
		}

		if (!rule.jobName.trim()) {
			issues.push(
				`repair.format_checks[${index}].jobName must be a non-empty string.`,
			);
		}

		if (!Array.isArray(rule.stepNames) || rule.stepNames.length === 0) {
			issues.push(
				`repair.format_checks[${index}].stepNames must be a non-empty array.`,
			);
			continue;
		}

		if (!rule.stepNames.every((stepName) => stepName.trim().length > 0)) {
			issues.push(
				`repair.format_checks[${index}].stepNames must contain only non-empty strings.`,
			);
		}
	}

	if (issues.length > 0) {
		throw new RepairConfigError(issues);
	}
}

function cloneDefaultRepairConfig(): RepairConfig {
	return {
		repair: {
			format_checks: [],
		},
	};
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
		throw new RepairConfigError([`Expected a quoted string, got ${value}.`]);
	}
}

function parseStringArray(input: string): string[] {
	const match = /^\[(.*)\]$/.exec(input);

	if (!match?.[1]) {
		throw new RepairConfigError([`Expected a string array, got '${input}'.`]);
	}

	const items = splitCsvTopLevel(match[1]);
	return items.map((rawItem) => {
		const value = rawItem.trim();

		if (!value.startsWith('"') || !value.endsWith('"') || value.length < 2) {
			throw new RepairConfigError([
				`Expected quoted string in array, got '${value}'.`,
			]);
		}

		return JSON.parse(value) as string;
	});
}

function splitCsvTopLevel(input: string): string[] {
	const items: string[] = [];
	let inQuotes = false;
	let current = "";
	let escaped = false;

	for (const char of input) {
		if (char === "," && !inQuotes) {
			if (current.trim()) {
				items.push(current.trim());
			}
			current = "";
			continue;
		}

		if (char === '"') {
			if (!escaped) {
				inQuotes = !inQuotes;
			}
			escaped = false;
			current += char;
			continue;
		}

		if (char === "\\") {
			escaped = !escaped;
			current += char;
			continue;
		}

		current += char;
		escaped = false;
	}

	if (current.trim()) {
		items.push(current.trim());
	}

	return items.filter((item) => item.length > 0);
}
