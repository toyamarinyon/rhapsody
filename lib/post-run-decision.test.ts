import assert from "node:assert/strict";
import test from "node:test";
import {
	getPostRunStatusConfig,
	parsePostRunDecisionConfig,
	evaluatePostRunDecision,
	type PostRunDecisionConfig,
} from "./post-run-decision.ts";

const baseDecisionConfig: PostRunDecisionConfig = {
	post_run: {
		auto_merge_success_status: "Done",
		human_review_status: "Human Review",
		auto_merge_eligible: [
			{
				paths: ["docs/**", "!docs/adr/**"],
			},
		],
	},
};

const baseDecisionInput = {
	runStatus: "completed",
	attemptStatus: "completed",
	handoffStatus: "ok" as const,
	config: baseDecisionConfig,
};

test("matches when file is covered by positive path and not excluded", () => {
	const decision = evaluatePostRunDecision({
		...baseDecisionInput,
		changedFiles: ["docs/guides/architecture.md"],
	});

	assert.equal(decision.action, "auto_merge_candidate");
	assert.deepEqual(decision.changedPathsSummary.excluded, []);
	assert.deepEqual(decision.changedPathsSummary.unmatched, []);
	assert.deepEqual(decision.changedPathsSummary.matched, [
		"docs/guides/architecture.md",
	]);
});

test("does not match when all changed files are excluded by inline negative pattern", () => {
	const decision = evaluatePostRunDecision({
		...baseDecisionInput,
		changedFiles: ["docs/adr/0001-overview.md"],
	});

	assert.equal(decision.action, "human_review");
	assert.deepEqual(decision.changedPathsSummary.excluded, [
		"docs/adr/0001-overview.md",
	]);
	assert.deepEqual(decision.changedPathsSummary.unmatched, []);
	assert.deepEqual(decision.changedPathsSummary.matched, []);
});

test("does not require every positive include pattern to match", () => {
	const decision = evaluatePostRunDecision({
		...baseDecisionInput,
		config: {
			post_run: {
				auto_merge_success_status: "Done",
				human_review_status: "Human Review",
				auto_merge_eligible: [
					{
						paths: ["docs/**", "src/**"],
					},
				],
			},
		},
		changedFiles: ["docs/readme.md"],
	});

	assert.equal(decision.action, "auto_merge_candidate");
	assert.deepEqual(decision.changedPathsSummary.unmatched, []);
});

test("supports config-driven post-run destination statuses", () => {
	const parsed = parsePostRunDecisionConfig(`
[post_run]
auto_merge_success_status = "Deployed"
human_review_status = "Needs Human Review"

[[post_run.auto_merge_eligible]]
paths = ["docs/**"]
`);

	const statusConfig = getPostRunStatusConfig(parsed);

	assert.deepEqual(statusConfig, {
		autoMergeSuccessStatus: "Deployed",
		humanReviewStatus: "Needs Human Review",
	});
});

test("defaults destination status values when omitted", () => {
	const parsed = parsePostRunDecisionConfig(`
[post_run]
[[post_run.auto_merge_eligible]]
paths = ["docs/**"]
`);

	const statusConfig = getPostRunStatusConfig(parsed);

	assert.deepEqual(statusConfig, {
		autoMergeSuccessStatus: "Done",
		humanReviewStatus: "Human Review",
	});
});
