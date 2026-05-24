import { readFile } from "node:fs/promises";
import path from "node:path";

const RHAPSODY_CONFIG_PATH = ".rhapsody/config.toml";

export type RunnerCodexConfig = {
	model: string;
	reasoningEffort?: string;
	sandbox?: {
		networkPolicy?: RunnerCodexSandboxNetworkPolicy;
	};
};

export type RunnerCodexConfigLoadResult = {
	config: RunnerCodexConfig | null;
	loadedFromPath: string;
};

export type RunnerCodexSandboxNetworkPolicy = {
	preset?: "common_dependencies";
	domains?: Record<string, "allow">;
};

export const COMMON_DEPENDENCIES_NETWORK_DOMAIN_ALLOWS = [
	"alpinelinux.org",
	"anaconda.com",
	"apache.org",
	"apt.llvm.org",
	"archlinux.org",
	"azure.com",
	"bitbucket.org",
	"bower.io",
	"centos.org",
	"cocoapods.org",
	"continuum.io",
	"cpan.org",
	"crates.io",
	"debian.org",
	"docker.com",
	"docker.io",
	"dot.net",
	"dotnet.microsoft.com",
	"eclipse.org",
	"fedoraproject.org",
	"gcr.io",
	"ghcr.io",
	"github.com",
	"githubusercontent.com",
	"gitlab.com",
	"golang.org",
	"google.com",
	"goproxy.io",
	"gradle.org",
	"hashicorp.com",
	"haskell.org",
	"hex.pm",
	"java.com",
	"java.net",
	"jcenter.bintray.com",
	"json-schema.org",
	"json.schemastore.org",
	"k8s.io",
	"launchpad.net",
	"maven.org",
	"mcr.microsoft.com",
	"metacpan.org",
	"microsoft.com",
	"nodejs.org",
	"npmjs.com",
	"npmjs.org",
	"nuget.org",
	"oracle.com",
	"packagecloud.io",
	"packages.microsoft.com",
	"packagist.org",
	"pkg.go.dev",
	"ppa.launchpad.net",
	"pub.dev",
	"pypa.io",
	"pypi.org",
	"pypi.python.org",
	"pythonhosted.org",
	"quay.io",
	"ruby-lang.org",
	"rubyforge.org",
	"rubygems.org",
	"rubyonrails.org",
	"rustup.rs",
	"rvm.io",
	"sourceforge.net",
	"spring.io",
	"swift.org",
	"ubuntu.com",
	"visualstudio.com",
	"yarnpkg.com",
] as const satisfies readonly string[];

const COMMON_DEPENDENCIES_SUPPORTED_PRESETS = [
	"common_dependencies",
] as const satisfies readonly RunnerCodexSandboxNetworkPolicy["preset"][];
const COMMON_DEPENDENCIES_DOMAIN_ACTIONS = [
	"allow",
] as const satisfies readonly "allow"[];

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
	let section:
		| "runner.codex"
		| "sandbox.network_policy"
		| "sandbox.network_policy.domains"
		| null = null;
	let sectionSeen = false;
	const config: Partial<RunnerCodexConfig> = {};
	const sandboxNetworkPolicy: RunnerCodexSandboxNetworkPolicy = {
		domains: {},
	};

	for (const rawLine of lines) {
		const trimmed = stripComment(rawLine).trim();

		if (!trimmed) {
			continue;
		}

		if (trimmed === "[runner.codex]") {
			section = "runner.codex";
			sectionSeen = true;
			continue;
		}

		if (trimmed === "[sandbox.network_policy]") {
			section = "sandbox.network_policy";
			sectionSeen = true;
			continue;
		}

		if (trimmed === "[sandbox.network_policy.domains]") {
			section = "sandbox.network_policy.domains";
			sectionSeen = true;
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
			throw new RunnerCodexConfigError([assignResult.error]);
		}

		if (section === "runner.codex") {
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

			continue;
		}

		if (section === "sandbox.network_policy") {
			if (assignResult.key !== "preset") {
				throw new RunnerCodexConfigError([
					`Unknown field '${assignResult.key}' in [sandbox.network_policy].`,
				]);
			}

			sandboxNetworkPolicy.preset = parseSupportedNetworkPolicyPreset(
				assignResult.value,
			);
			continue;
		}

		if (section !== "sandbox.network_policy.domains") {
			throw new RunnerCodexConfigError([
				`Unknown field '${assignResult.key}' in [.].`,
			]);
		}

		const domain = parseSandboxPolicyDomainEntry(assignResult.key);
		const action = parseSandboxPolicyDomainAction(assignResult.value);
		sandboxNetworkPolicy.domains ??= {};

		if (sandboxNetworkPolicy.domains[domain] !== action) {
			sandboxNetworkPolicy.domains[domain] = action;
		}
	}

	if (!sectionSeen) {
		return null;
	}

	if (
		section === "sandbox.network_policy.domains" ||
		section === "sandbox.network_policy" ||
		Object.keys(sandboxNetworkPolicy.domains ?? {}).length > 0 ||
		sandboxNetworkPolicy.preset
	) {
		config.sandbox = { networkPolicy: sandboxNetworkPolicy };
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

	if (config.sandbox?.networkPolicy) {
		validateSandboxNetworkPolicy(config.sandbox.networkPolicy);
	}
}

function parseSupportedNetworkPolicyPreset(value: string) {
	const parsed = parseTomlString(value);

	if (!isSupportedNetworkPolicyPreset(parsed)) {
		throw new RunnerCodexConfigError([
			`Unsupported sandbox network policy preset '${parsed}'. Supported presets: ${COMMON_DEPENDENCIES_SUPPORTED_PRESETS.join(", ")}.`,
		]);
	}

	return parsed;
}

function isSupportedNetworkPolicyPreset(
	value: string,
): value is NonNullable<RunnerCodexSandboxNetworkPolicy["preset"]> {
	return COMMON_DEPENDENCIES_SUPPORTED_PRESETS.includes(
		value as NonNullable<RunnerCodexSandboxNetworkPolicy["preset"]>,
	);
}

export function parseSandboxPolicyDomainEntry(rawDomain: string): string {
	const trimmed = rawDomain.trim();

	if (!trimmed) {
		throw new RunnerCodexConfigError([
			"Sandbox network policy domain key must be a non-empty string.",
		]);
	}

	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		try {
			return JSON.parse(trimmed);
		} catch {
			throw new RunnerCodexConfigError([
				`Expected a quoted string domain key, got ${trimmed}.`,
			]);
		}
	}

	return trimmed;
}

export function parseSandboxPolicyDomainAction(rawAction: string): "allow" {
	const action = parseTomlString(rawAction);

	if (!isSupportedDomainAction(action)) {
		throw new RunnerCodexConfigError([
			`Unsupported sandbox network policy action '${action}' for domain. Supported actions: ${COMMON_DEPENDENCIES_DOMAIN_ACTIONS.join(", ")}.`,
		]);
	}

	return action;
}

function isSupportedDomainAction(value: string): value is "allow" {
	return COMMON_DEPENDENCIES_DOMAIN_ACTIONS.includes(value as "allow");
}

export function expandSandboxNetworkPolicyForPreset(
	rawPolicy?: RunnerCodexSandboxNetworkPolicy,
): string[] {
	if (!rawPolicy) {
		return [];
	}

	const domains = new Set<string>();
	const entries: Array<{ domain: string; action: "allow" }> = [];

	if (rawPolicy.preset === "common_dependencies") {
		for (const domain of COMMON_DEPENDENCIES_NETWORK_DOMAIN_ALLOWS) {
			entries.push({
				domain,
				action: "allow",
			});
		}
	}

	for (const [domain, action] of Object.entries(rawPolicy.domains ?? {})) {
		entries.push({
			domain,
			action,
		});
	}

	for (const entry of entries) {
		if (entry.action !== "allow") {
			continue;
		}
		domains.add(entry.domain);
		domains.add(formatDomainWithSubdomains(entry.domain));
	}

	return [...domains];
}

function formatDomainWithSubdomains(domain: string): string {
	if (
		domain.startsWith("**.") ||
		domain.startsWith("*.") ||
		domain.startsWith("*")
	) {
		return domain;
	}

	return `**.${domain}`;
}

function validateSandboxNetworkPolicy(policy: RunnerCodexSandboxNetworkPolicy) {
	if (policy.preset !== undefined) {
		parseSupportedNetworkPolicyPreset(JSON.stringify(policy.preset));
	}

	for (const [domain, action] of Object.entries(policy.domains ?? {})) {
		if (!domain.trim()) {
			throw new RunnerCodexConfigError([
				"Sandbox network policy domain key must be a non-empty string.",
			]);
		}

		parseSandboxPolicyDomainAction(JSON.stringify(action));
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
