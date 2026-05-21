import assert from "node:assert/strict";
import test from "node:test";
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

	assert.deepEqual(config, {
		model: "gpt-5.2",
		reasoningEffort: "medium",
	});
});

test("returns null when runner Codex config is omitted", () => {
	const config = parseRunnerCodexConfig(`
[post_run]
human_review_status = "Human Review"
`);

	assert.equal(config, null);
});

test("requires model when runner Codex section is present", () => {
	assert.throws(
		() =>
			parseRunnerCodexConfig(`
[runner.codex]
reasoning_effort = "medium"
`),
		RunnerCodexConfigError,
	);
});
