import { expect, test } from "vitest";
import {
	getPostRunStatusConfig,
	parsePostRunDecisionConfig,
	evaluatePostRunDecision,
	type PostRunDecisionConfig,
} from "./post-run-decision";

const defaultHumanReviewMonitoringPolicy = {
	enabled: true,
	auto_integrate_base_before_human_activity: true,
	auto_integrate_base_after_human_activity: false,
	comment_on_conflict: true,
};

const baseDecisionConfig: PostRunDecisionConfig = {
	post_run: {
		auto_merge_success_status: "Done",
		human_review_status: "Human Review",
		human_review_monitoring: defaultHumanReviewMonitoringPolicy,
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

	expect(decision.action).toBe("auto_merge_candidate");
	expect(decision.changedPathsSummary.excluded).toEqual([]);
	expect(decision.changedPathsSummary.unmatched).toEqual([]);
	expect(decision.changedPathsSummary.matched).toEqual([
		"docs/guides/architecture.md",
	]);
});

test("does not match when all changed files are excluded by inline negative pattern", () => {
	const decision = evaluatePostRunDecision({
		...baseDecisionInput,
		changedFiles: ["docs/adr/0001-overview.md"],
	});

	expect(decision.action).toBe("human_review");
	expect(decision.changedPathsSummary.excluded).toEqual([
		"docs/adr/0001-overview.md",
	]);
	expect(decision.changedPathsSummary.unmatched).toEqual([]);
	expect(decision.changedPathsSummary.matched).toEqual([]);
});

test("does not require every positive include pattern to match", () => {
	const decision = evaluatePostRunDecision({
		...baseDecisionInput,
		config: {
			post_run: {
				auto_merge_success_status: "Done",
				human_review_status: "Human Review",
				human_review_monitoring: defaultHumanReviewMonitoringPolicy,
				auto_merge_eligible: [
					{
						paths: ["docs/**", "src/**"],
					},
				],
			},
		},
		changedFiles: ["docs/readme.md"],
	});

	expect(decision.action).toBe("auto_merge_candidate");
	expect(decision.changedPathsSummary.unmatched).toEqual([]);
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

	expect(statusConfig).toEqual({
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

	expect(statusConfig).toEqual({
		autoMergeSuccessStatus: "Done",
		humanReviewStatus: "Human Review",
	});
});

test("defaults human review monitoring policy values when omitted", () => {
	const parsed = parsePostRunDecisionConfig(`
[post_run]

[[post_run.auto_merge_eligible]]
paths = ["docs/**"]
`);

	expect(parsed.post_run.human_review_monitoring).toEqual({
		enabled: true,
		auto_integrate_base_before_human_activity: true,
		auto_integrate_base_after_human_activity: false,
		comment_on_conflict: true,
	});
});

test("parses human review monitoring policy overrides", () => {
	const parsed = parsePostRunDecisionConfig(`
[post_run]

[post_run.human_review_monitoring]
enabled = false
auto_integrate_base_before_human_activity = false
auto_integrate_base_after_human_activity = true
comment_on_conflict = false
`);

	expect(parsed.post_run.human_review_monitoring).toEqual({
		enabled: false,
		auto_integrate_base_before_human_activity: false,
		auto_integrate_base_after_human_activity: true,
		comment_on_conflict: false,
	});
});
