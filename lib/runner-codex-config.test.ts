import { expect, test } from "vitest";
import {
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
