import { expect, test } from "vitest";
import {
	expandSandboxNetworkPolicyForPreset,
	parseRunnerCodexConfig,
	RunnerCodexConfigError,
} from "./runner-codex-config";

test("parses runner Codex model and reasoning effort", () => {
	const config = parseRunnerCodexConfig(`
[runner.codex]
model = "gpt-5.2"
reasoning_effort = "medium"

[post_run]
human_review_status = "Human Review"
`);

	expect(config).toEqual({
		model: "gpt-5.2",
		reasoningEffort: "medium",
	});
});

test("returns null when runner Codex config is omitted", () => {
	const config = parseRunnerCodexConfig(`
[post_run]
human_review_status = "Human Review"
`);

	expect(config).toBeNull();
});

test("requires model when runner Codex section is present", () => {
	expect(() =>
		parseRunnerCodexConfig(`
[runner.codex]
reasoning_effort = "medium"
`),
	).toThrow(RunnerCodexConfigError);
});

test("parses sandbox network policy preset and domain map", () => {
	const config = parseRunnerCodexConfig(`
[runner.codex]
model = "gpt-5.2"

[sandbox.network_policy]
preset = "common_dependencies"

[sandbox.network_policy.domains]
"registry.npmjs.org" = "allow"
"npm.example.com" = "allow"
`);

	expect(config).toEqual({
		model: "gpt-5.2",
		sandbox: {
			networkPolicy: {
				preset: "common_dependencies",
				domains: {
					"registry.npmjs.org": "allow",
					"npm.example.com": "allow",
				},
			},
		},
	});
});

test("expands sandbox network policy allowlist with preset and dedupes entries", () => {
	const config = parseRunnerCodexConfig(`
[runner.codex]
model = "gpt-5.2"

[sandbox.network_policy]
preset = "common_dependencies"

[sandbox.network_policy.domains]
"registry.npmjs.org" = "allow"
"registry.yarnpkg.com" = "allow"
`);

	const expanded = expandSandboxNetworkPolicyForPreset(
		config?.sandbox?.networkPolicy,
	);

	expect([
		expanded.includes("npmjs.org"),
		expanded.includes("*.npmjs.org"),
		expanded.includes("yarnpkg.com"),
		expanded.includes("*.yarnpkg.com"),
		expanded.filter((domain) => domain === "registry.npmjs.org").length,
		expanded.filter((domain) => domain === "*.registry.npmjs.org").length,
	]).toEqual([true, true, true, true, 1, 1]);
});

test("rejects unsupported sandbox network policy actions", () => {
	expect(() =>
		parseRunnerCodexConfig(`
[runner.codex]
model = "gpt-5.2"

[sandbox.network_policy.domains]
"registry.npmjs.org" = "block"
`),
	).toThrow(RunnerCodexConfigError);
});
