import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { expect, test, vi } from "vitest";
import { normalizeProjectConfig } from "@/lib/config";
import type { PullRequestCheckSummary } from "@/lib/github/checks";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";
import { GitHubPullRequestError } from "@/lib/github/pull-requests";
import {
	createArtifact,
	createClaimedManualRun,
	createDecision,
	createWorkerRun,
	listWorkItemGraph,
	migrateStateStore,
} from "@/lib/state";
import {
	buildIntakeInputFingerprint,
	runIntakeCurator,
} from "@/lib/workers/intake-curator";
import {
	buildFailureFingerprint,
	buildRepairExecutionKey,
	runRepairerPlanner,
} from "@/lib/workers/repairer";
import { runSchedulerTick } from "./tick";

const baseConfig = normalizeProjectConfig({
	tracker: {
		kind: "github_project",
		owner: "toyamarinyon",
		repository: "rhapsody",
		projectNumber: 4,
		statusField: "Status",
		activeStatuses: ["Todo", "In Progress"],
		terminalStatuses: ["Done"],
	},
	repository: {
		owner: "toyamarinyon",
		name: "rhapsody",
		defaultBranch: "main",
		branchPrefix: "rhapsody/",
	},
	scheduler: {
		maxConcurrentRuns: 3,
		maxConcurrentRunsByStatus: {},
		maxRetryBackoffMs: 300_000,
	},
	runner: {
		kind: "sandbox-codex",
		timeoutMs: 60_000,
	},
});

const defaultHumanReviewMonitoringPolicy = {
	enabled: true,
	auto_integrate_base_before_human_activity: true,
	auto_integrate_base_after_human_activity: false,
	comment_on_conflict: true,
};

function buildPostRunPolicyLoadResult(input?: {
	auto_merge_eligible?: { paths: string[] }[];
	auto_merge_success_status?: string;
	human_review_status?: string;
}) {
	return {
		config: {
			post_run: {
				auto_merge_eligible: input?.auto_merge_eligible ?? [],
				auto_merge_success_status: input?.auto_merge_success_status ?? "Done",
				human_review_status: input?.human_review_status ?? "Human Review",
				human_review_monitoring: {
					...defaultHumanReviewMonitoringPolicy,
				},
			},
		},
		loadedFromPath: ".rhapsody/config.toml",
		errors: [],
	};
}

test("scheduler records intake and builder graph for buildable Todo items", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 101,
		projectStatus: "Todo",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			runIntakeCurator: runBuildableIntakeCurator,
			updateProjectIssueStatus: async () => ({
				projectId: "project",
				itemId: "item",
				fieldId: "field",
				optionId: "option",
				status: "In Progress",
			}),
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		expect(result.value.created).toBe(1);
		const graph = await listWorkItemGraph(
			client,
			"github_issue:toyamarinyon/rhapsody#101",
		);

		expect(graph.workerRuns.some((run) => run.kind === "intake_curator")).toBe(
			true,
		);
		expect(graph.workerRuns.some((run) => run.kind === "builder")).toBe(true);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "intake" && decision.outcome === "buildable",
			),
		).toBe(true);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "dispatch" && decision.outcome === "start_builder",
			),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler records ask_human and skips builder for sparse Todo items", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 102,
		projectStatus: "Todo",
		issueBody: "",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			runIntakeCurator: runAskHumanIntakeCurator,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		expect(result.value.created).toBe(0);
		expect(result.value.skippedIssues).toEqual([
			{
				workItemId: "github_issue:toyamarinyon/rhapsody#102",
				issueNumber: 102,
				reason: "ask_human",
			},
		]);

		const graph = await listWorkItemGraph(
			client,
			"github_issue:toyamarinyon/rhapsody#102",
		);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "intake" && decision.outcome === "ask_human",
			),
		).toBe(true);
		expect(graph.workerRuns.some((run) => run.kind === "builder")).toBe(false);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler re-runs intake on newer human comment after ask_human", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 109,
		projectStatus: "Todo",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#109";
	const oldFingerprint = buildIntakeInputFingerprint({
		issueNumber: 109,
		issueTitle: item.issueTitle,
		issueBody: item.issueBody,
		issueUrl: item.issueUrl,
		issueState: item.issueState,
		projectStatus: item.projectStatus,
		blockedBy: [],
		projectFields: item.projectFields,
		repository: item.repository,
	});

	const workerRun = await createWorkerRun(client, {
		id: "wrn_ask_scheduler",
		workItemId,
		kind: "intake_curator",
		status: "completed",
	});
	await createArtifact(client, {
		id: "art_ask_scheduler",
		workItemId,
		workerRunId: workerRun.id,
		kind: "intake_comment",
		externalId: "1",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/issues/109",
		now: 1_000_000,
		metadata: {
			inputFingerprint: oldFingerprint,
		},
	});
	await createDecision(client, {
		id: "dec_ask_scheduler",
		workItemId,
		workerRunId: workerRun.id,
		phase: "intake",
		outcome: "ask_human",
		evidence: {
			inputFingerprint: oldFingerprint,
			reason: "Need more context.",
		},
	});

	const result = await runSchedulerTick(client, {
		config: baseConfig,
		fetchProjectIssueWorkItems: async () => [item],
		runIntakeCurator: async (runClient, runItem, runWorkItemId, runOptions) =>
			runIntakeCurator(runClient, runItem, runWorkItemId, {
				...runOptions,
				dependencies: {
					...runOptions?.dependencies,
					fetchBlockedBy: async () => [],
					fetchIssueComments: async () => [
						{
							id: 2,
							body: "Please proceed with extra checks.",
							htmlUrl:
								"https://github.com/toyamarinyon/rhapsody/issues/109#issuecomment-2",
							createdAt: "1970-01-01T00:20:00Z",
							updatedAt: "1970-01-01T00:20:00Z",
							authorLogin: "human",
						},
					],
				},
				classify: async () => ({
					classification: {
						decision: "buildable",
						summary: "Re-classified from human reply.",
						implementation_plan: "Start builder from updated context.",
						comment: "I can proceed now.",
						next_action: "start_builder",
					},
					raw: "{}",
					command: "mock",
				}),
				comment: async (comment) => ({
					id: comment.issueNumber,
					htmlUrl: `${comment.owner}/${comment.repository}#${comment.issueNumber}`,
				}),
			}),
		updateProjectIssueStatus: async () => ({
			projectId: "project",
			itemId: "item",
			fieldId: "field",
			optionId: "option",
			status: "In Progress",
		}),
	});

	try {
		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		expect(result.value.created).toBe(1);
		expect(result.value.skippedIssues).toHaveLength(0);
		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "intake" && decision.outcome === "buildable",
			),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler records blocked and skips builder for open blocked Todo items", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = {
		issueNumber: 103,
		issueTitle: "Blocked work",
		issueUrl: "https://github.com/toyamarinyon/rhapsody/issues/103",
		issueState: "OPEN",
		issueBody: "Depends on another ticket before this can be started.",
		projectStatus: "Todo",
		repository: {
			owner: "toyamarinyon",
			name: "rhapsody",
		},
		blockedBy: [{ id: "#111", state: "open" }],
		projectFields: {},
	};

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [workItem],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		expect(result.value.created).toBe(0);
		expect(result.value.skippedIssues).toEqual([
			{
				workItemId: "github_issue:toyamarinyon/rhapsody#103",
				issueNumber: 103,
				reason: "blocked",
			},
		]);

		const graph = await listWorkItemGraph(
			client,
			"github_issue:toyamarinyon/rhapsody#103",
		);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "intake" && decision.outcome === "blocked",
			),
		).toBe(true);
		expect(graph.workerRuns.some((run) => run.kind === "builder")).toBe(false);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler does not block when only closed blockers exist", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItem = {
		issueNumber: 104,
		issueTitle: "Depends on closed issue",
		issueUrl: "https://github.com/toyamarinyon/rhapsody/issues/104",
		issueState: "OPEN",
		issueBody: "Existing dependency is closed, so proceed.",
		projectStatus: "Todo",
		repository: {
			owner: "toyamarinyon",
			name: "rhapsody",
		},
		blockedBy: [{ id: "#901", state: "closed" }],
		projectFields: {},
	};

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [workItem],
			runIntakeCurator: runBuildableIntakeCurator,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		expect(result.value.created).toBe(1);
		expect(result.value.skippedIssues).toEqual([]);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler skips In Progress items with missing PR artifact", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 104,
		projectStatus: "In Progress",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		expect(result.value.created).toBe(0);
		expect(result.value.skippedIssues).toEqual([
			{
				workItemId: "github_issue:toyamarinyon/rhapsody#104",
				issueNumber: 104,
				reason: "missing_pr_artifact",
			},
		]);

		const graph = await listWorkItemGraph(
			client,
			"github_issue:toyamarinyon/rhapsody#104",
		);
		expect(graph.decisions).toHaveLength(0);
		expect(graph.workerRuns).toHaveLength(0);
		expect(graph.links).toHaveLength(0);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler keeps In Progress items unchanged while checks are pending", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 140,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#140";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "140",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/140",
	});
	const updateProjectIssueStatus = vi.fn();

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			getPullRequestCheckSummary: async () => ({
				classification: "checks_pending",
				headSha: "sha-pending",
				status: "pending",
				checkRuns: [
					{
						name: "CI",
						status: "queued",
						conclusion: null,
						detailsUrl: null,
					},
				],
			}),
		});

		expect(result.ok).toBe(true);
		expect(updateProjectIssueStatus).not.toHaveBeenCalled();

		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "post_pr" && decision.outcome === "checks_pending",
			),
		).toBe(true);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "post_pr" &&
					(decision.outcome === "human_review" || decision.outcome === "done"),
			),
		).toBe(false);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler moves non-repairable failed checks to Human Review", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 141,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#141";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "141",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/141",
	});
	const updateProjectIssueStatus = vi.fn().mockResolvedValue({
		projectId: "project",
		itemId: "item",
		fieldId: "field",
		optionId: "option",
		status: "Human Review",
	});
	const createIssueComment = vi.fn().mockResolvedValue({
		id: 141,
		htmlUrl:
			"https://github.com/toyamarinyon/rhapsody/issues/141#issuecomment-141",
	});
	const runRepairerExecutor = vi.fn();

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			createIssueComment,
			runRepairerExecutor,
			runRepairerPlanner: vi.fn().mockResolvedValue({
				workerRunId: "repair-planner-blocked",
				decisionId: "repair-blocked-decision",
				outcome: "repair_blocked",
				classification: "not_deterministically_fixable",
				attemptCount: 0,
				attemptCounts: { headSha: 0, pullRequest: 0, fingerprint: 0 },
				maxAttempts: {
					headSha: 2,
					pullRequest: 6,
					fingerprint: 2,
				},
				repairExecutionKey: "141:sha-blocked:failure",
				failureFingerprint: "failure",
			}),
			getPullRequestCheckSummary: async () => ({
				classification: "ci_failed",
				headSha: "sha-blocked",
				status: "failure",
				checkRuns: [
					{
						name: "Static checks",
						status: "completed",
						conclusion: "failure",
						detailsUrl: null,
					},
				],
			}),
		});

		expect(result.ok).toBe(true);
		expect(runRepairerExecutor).not.toHaveBeenCalled();
		expect(updateProjectIssueStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				issueNumber: 141,
				status: "Human Review",
			}),
		);
		expect(createIssueComment).toHaveBeenCalledTimes(1);
		expect(createIssueComment.mock.calls[0]?.[0].body).toContain(
			"Repair classification: not_deterministically_fixable",
		);

		const graph = await listWorkItemGraph(client, workItemId);
		const resolutionDecision = graph.decisions.find(
			(decision) =>
				decision.phase === "post_pr" && decision.outcome === "human_review",
		);
		expect(resolutionDecision?.evidence).toEqual(
			expect.objectContaining({
				checkClassification: "ci_failed",
				targetStatus: "Human Review",
				repairDecisionId: "repair-blocked-decision",
			}),
		);
		expect(
			graph.links.some(
				(link) =>
					link.fromNodeType === "decision" &&
					link.toNodeType === "decision" &&
					link.relation === "resolves_to",
			),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler moves unknown pull request checks to Human Review with a recorded reason", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 143,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#143";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "143",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/143",
	});
	const updateProjectIssueStatus = vi.fn().mockResolvedValue({
		projectId: "project",
		itemId: "item",
		fieldId: "field",
		optionId: "option",
		status: "Human Review",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			getPullRequestCheckSummary: async () => ({
				classification: "checks_unknown",
				headSha: "sha-unknown",
				status: "unknown",
				checkRuns: [],
			}),
		});

		expect(result.ok).toBe(true);
		expect(updateProjectIssueStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				issueNumber: 143,
				status: "Human Review",
			}),
		);

		const graph = await listWorkItemGraph(client, workItemId);
		const resolutionDecision = graph.decisions.find(
			(decision) =>
				decision.phase === "post_pr" && decision.outcome === "human_review",
		);
		expect(resolutionDecision?.evidence).toEqual(
			expect.objectContaining({
				checkClassification: "checks_unknown",
				targetStatus: "Human Review",
				reason:
					"Pull request checks could not be classified safely, so human review is required.",
			}),
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler monitors linked Human Review items without restarting builder work", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 150,
		projectStatus: "Human Review",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#150";
	const postPrWorkerRun = await createWorkerRun(client, {
		workItemId,
		kind: "post_pr_curator",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: postPrWorkerRun.id,
		kind: "pull_request",
		externalId: "150",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/150",
	});
	await createDecision(client, {
		workItemId,
		workerRunId: postPrWorkerRun.id,
		phase: "post_pr",
		outcome: "human_review",
		evidence: {
			pullRequestNumber: 150,
			sourceDecisionId: "dec_previous_post_pr",
			checkClassification: "checks_success",
			baseSha: "base-old",
			headSha: "head-old",
		},
	});
	const updateProjectIssueStatus = vi.fn();
	const getPullRequestCheckSummary = vi.fn().mockResolvedValue({
		classification: "checks_success",
		headSha: "head-new",
		status: "success",
		checkRuns: [],
	});
	const runIntegrationRepairPlanner = vi.fn().mockResolvedValue({
		workerRunId: "integration-planner-run",
		decisionId: "integration-planner-decision",
		outcome: "integration_repair_needed",
		skippedFreshDuplicate: false,
		integrationExecutionKey: "150:head-new:base-new",
		headSha: "head-new",
		baseSha: "base-new",
		branchComparison: {
			base: "main",
			head: "feature",
			status: "behind",
			aheadBy: 0,
			behindBy: 1,
			mergeBaseCommitSha: "merge-base",
		},
	});
	const runIntegrationRepairExecutor = vi.fn().mockResolvedValue({
		executed: true,
		outcome: "integration_repair_applied",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			loadPostRunDecisionConfig: async () => buildPostRunPolicyLoadResult(),
			updateProjectIssueStatus,
			fetchIssueComments: async () => [],
			getPullRequest: async () => ({
				reused: true,
				number: 150,
				htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/150",
				headRef: "feature",
				baseRef: "main",
				headSha: "head-new",
				baseSha: "base-new",
				title: "Human review item",
			}),
			getPullRequestCheckSummary,
			comparePullRequestBranches: async () => ({
				base: "main",
				head: "feature",
				status: "behind",
				aheadBy: 0,
				behindBy: 1,
				mergeBaseCommitSha: "merge-base",
			}),
			runIntegrationRepairPlanner,
			runIntegrationRepairExecutor,
		});

		expect(result.ok).toBe(true);
		expect(getPullRequestCheckSummary).toHaveBeenCalledTimes(1);
		expect(runIntegrationRepairPlanner).toHaveBeenCalledTimes(1);
		expect(runIntegrationRepairExecutor).toHaveBeenCalledTimes(1);
		expect(updateProjectIssueStatus).not.toHaveBeenCalled();
		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "post_pr" &&
					decision.outcome === "human_review_stale",
			),
		).toBe(true);
		expect(graph.workerRuns.some((run) => run.kind === "builder")).toBe(false);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler auto-merges eligible pull requests after checks succeed", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 142,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#142";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "142",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/142",
	});
	const updateProjectIssueStatus = vi.fn().mockResolvedValue({
		projectId: "project",
		itemId: "item",
		fieldId: "field",
		optionId: "option",
		status: "Done",
	});
	const mergePullRequest = vi.fn().mockResolvedValue({
		number: 142,
		merged: true,
		message: "merged",
		sha: "sha-merged",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequest: async () => buildPullRequestSummary({ number: 142 }),
			updateProjectIssueStatus,
			mergePullRequest,
			getPullRequestChangedFiles: async () => ["docs/guide.md"],
			loadPostRunDecisionConfig: async () =>
				buildPostRunPolicyLoadResult({
					auto_merge_eligible: [{ paths: ["docs/**"] }],
				}),
			getPullRequestCheckSummary: async () => ({
				classification: "checks_success",
				headSha: "sha-success",
				status: "success",
				checkRuns: [
					{
						name: "CI",
						status: "completed",
						conclusion: "success",
						detailsUrl: null,
					},
				],
			}),
		});

		expect(result.ok).toBe(true);
		expect(mergePullRequest).toHaveBeenCalledTimes(1);
		expect(updateProjectIssueStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				issueNumber: 142,
				status: "Done",
			}),
		);

		const graph = await listWorkItemGraph(client, workItemId);
		const resolutionDecision = graph.decisions.find(
			(decision) => decision.phase === "post_pr" && decision.outcome === "done",
		);
		expect(resolutionDecision?.evidence).toEqual(
			expect.objectContaining({
				checkClassification: "checks_success",
				targetStatus: "Done",
				postRunDecision: expect.objectContaining({
					action: "auto_merge_candidate",
					ruleIndex: 0,
				}),
			}),
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler recovers Project status update after merge already completed on previous tick", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 145,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#145";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "145",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/145",
	});
	const updateProjectIssueStatus = vi
		.fn()
		.mockRejectedValueOnce(new Error("Project API unavailable"))
		.mockResolvedValue({
			projectId: "project",
			itemId: "item",
			fieldId: "field",
			optionId: "option",
			status: "Done",
		});
	const mergePullRequest = vi
		.fn()
		.mockResolvedValueOnce({
			number: 145,
			merged: true,
			message: "merged",
			sha: "sha-first-merge",
		})
		.mockRejectedValueOnce(
			new GitHubPullRequestError(
				405,
				"toyamarinyon",
				"rhapsody",
				"merge",
				"Pull Request is already merged",
			),
		);
	const getPullRequest = vi.fn().mockResolvedValue({
		reused: true,
		number: 145,
		htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/145",
		title: "Auto-merge title",
		headRef: "feature",
		baseRef: "main",
		merged: true,
		sha: "sha-first-merge",
	});
	const getPullRequestCheckSummary = vi.fn().mockResolvedValue({
		classification: "checks_success",
		headSha: "sha-success",
		status: "success",
		checkRuns: [
			{
				name: "CI",
				status: "completed",
				conclusion: "success",
				detailsUrl: null,
			},
		],
	});

	try {
		const firstResult = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			mergePullRequest,
			getPullRequest,
			getPullRequestChangedFiles: async () => ["docs/guide.md"],
			loadPostRunDecisionConfig: async () =>
				buildPostRunPolicyLoadResult({
					auto_merge_eligible: [{ paths: ["docs/**"] }],
				}),
			getPullRequestCheckSummary,
		});
		expect(firstResult.ok).toBe(true);
		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(getPullRequestCheckSummary).toHaveBeenCalledTimes(1);
		const firstGraph = await listWorkItemGraph(client, workItemId);
		expect(
			firstGraph.decisions.some(
				(decision) =>
					decision.phase === "post_pr" && decision.outcome === "done",
			),
		).toBe(false);

		const secondResult = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			mergePullRequest,
			getPullRequest,
			getPullRequestChangedFiles: async () => ["docs/guide.md"],
			loadPostRunDecisionConfig: async () =>
				buildPostRunPolicyLoadResult({
					auto_merge_eligible: [{ paths: ["docs/**"] }],
				}),
			getPullRequestCheckSummary,
		});

		expect(secondResult.ok).toBe(true);
		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(getPullRequestCheckSummary).toHaveBeenCalledTimes(2);
		expect(getPullRequest).toHaveBeenCalledTimes(2);
		const secondGraph = await listWorkItemGraph(client, workItemId);
		expect(
			secondGraph.decisions.some(
				(decision) =>
					decision.phase === "post_pr" && decision.outcome === "done",
			),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler does not mark Done when auto-merge fails and pull request is not merged", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 146,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#146";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "146",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/146",
	});
	const updateProjectIssueStatus = vi.fn();
	const mergePullRequest = vi
		.fn()
		.mockRejectedValue(
			new GitHubPullRequestError(
				405,
				"toyamarinyon",
				"rhapsody",
				"merge",
				"Pull Request is not mergeable",
			),
		);
	const getPullRequest = vi.fn().mockResolvedValue({
		reused: true,
		number: 146,
		htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/146",
		title: "Auto-merge title",
		headRef: "feature",
		baseRef: "main",
		merged: false,
		sha: "sha-unmerged",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			mergePullRequest,
			getPullRequest,
			getPullRequestChangedFiles: async () => ["docs/guide.md"],
			loadPostRunDecisionConfig: async () =>
				buildPostRunPolicyLoadResult({
					auto_merge_eligible: [{ paths: ["docs/**"] }],
				}),
			getPullRequestCheckSummary: async () => ({
				classification: "checks_success",
				headSha: "sha-success",
				status: "success",
				checkRuns: [
					{
						name: "CI",
						status: "completed",
						conclusion: "success",
						detailsUrl: null,
					},
				],
			}),
		});

		expect(result.ok).toBe(true);
		expect(mergePullRequest).toHaveBeenCalledTimes(1);
		expect(getPullRequest).toHaveBeenCalledTimes(2);
		expect(updateProjectIssueStatus).not.toHaveBeenCalled();

		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "post_pr" && decision.outcome === "done",
			),
		).toBe(false);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler moves successful pull requests with unmatched paths to Human Review", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 144,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#144";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "144",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/144",
	});
	const updateProjectIssueStatus = vi.fn().mockResolvedValue({
		projectId: "project",
		itemId: "item",
		fieldId: "field",
		optionId: "option",
		status: "Human Review",
	});
	const mergePullRequest = vi.fn();

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			mergePullRequest,
			getPullRequestChangedFiles: async () => ["src/index.ts"],
			loadPostRunDecisionConfig: async () =>
				buildPostRunPolicyLoadResult({
					auto_merge_eligible: [{ paths: ["docs/**"] }],
				}),
			getPullRequestCheckSummary: async () => ({
				classification: "checks_success",
				headSha: "sha-human-review",
				status: "success",
				checkRuns: [
					{
						name: "CI",
						status: "completed",
						conclusion: "success",
						detailsUrl: null,
					},
				],
			}),
		});

		expect(result.ok).toBe(true);
		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(updateProjectIssueStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				issueNumber: 144,
				status: "Human Review",
			}),
		);

		const graph = await listWorkItemGraph(client, workItemId);
		const resolutionDecision = graph.decisions.find(
			(decision) =>
				decision.phase === "post_pr" && decision.outcome === "human_review",
		);
		expect(resolutionDecision?.evidence).toEqual(
			expect.objectContaining({
				checkClassification: "checks_success",
				targetStatus: "Human Review",
				postRunDecision: expect.objectContaining({
					action: "human_review",
					reason: "No auto-merge policy rule matched all changed paths.",
				}),
			}),
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler retries Done status after a prior merge succeeded", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 143,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#143";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "143",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/143",
	});
	const updateProjectIssueStatus = vi
		.fn()
		.mockRejectedValueOnce(new Error("project update failed"))
		.mockResolvedValueOnce({
			projectId: "project",
			itemId: "item",
			fieldId: "field",
			optionId: "option",
			status: "Done",
		});
	const getPullRequest = vi
		.fn()
		.mockResolvedValueOnce(buildPullRequestSummary({ number: 143 }))
		.mockResolvedValueOnce(
			buildPullRequestSummary({
				number: 143,
				state: "closed",
				merged: true,
				mergedAt: "2026-05-24T00:00:00Z",
			}),
		);
	const mergePullRequest = vi.fn().mockResolvedValue({
		number: 143,
		merged: true,
		message: "merged",
		sha: "sha-merged",
	});

	try {
		const firstResult = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequest,
			updateProjectIssueStatus,
			mergePullRequest,
			getPullRequestChangedFiles: async () => ["docs/guide.md"],
			loadPostRunDecisionConfig: async () =>
				buildPostRunPolicyLoadResult({
					auto_merge_eligible: [{ paths: ["docs/**"] }],
				}),
			getPullRequestCheckSummary: async () => ({
				classification: "checks_success",
				headSha: "sha-success",
				status: "success",
				checkRuns: [
					{
						name: "CI",
						status: "completed",
						conclusion: "success",
						detailsUrl: null,
					},
				],
			}),
		});
		const secondResult = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequest,
			updateProjectIssueStatus,
			mergePullRequest,
			getPullRequestChangedFiles: async () => ["docs/guide.md"],
			loadPostRunDecisionConfig: async () =>
				buildPostRunPolicyLoadResult({
					auto_merge_eligible: [{ paths: ["docs/**"] }],
				}),
			getPullRequestCheckSummary: async () => ({
				classification: "checks_success",
				headSha: "sha-success",
				status: "success",
				checkRuns: [
					{
						name: "CI",
						status: "completed",
						conclusion: "success",
						detailsUrl: null,
					},
				],
			}),
		});

		expect(firstResult.ok).toBe(true);
		expect(secondResult.ok).toBe(true);
		expect(getPullRequest).toHaveBeenCalledTimes(2);
		expect(mergePullRequest).toHaveBeenCalledTimes(1);
		expect(updateProjectIssueStatus).toHaveBeenCalledTimes(2);
		expect(updateProjectIssueStatus).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				issueNumber: 143,
				status: "Done",
			}),
		);
		expect(updateProjectIssueStatus).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				issueNumber: 143,
				status: "Done",
			}),
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler does not mark Done when merge fails for an open pull request", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	// Verification-only nudge for PR repair flow.
	const item = buildProjectItem({
		issueNumber: 144,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#144";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "144",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/144",
	});
	const updateProjectIssueStatus = vi.fn();
	const getPullRequest = vi
		.fn()
		.mockResolvedValueOnce(buildPullRequestSummary({ number: 144 }))
		.mockResolvedValueOnce(buildPullRequestSummary({ number: 144 }));
	const mergePullRequest = vi
		.fn()
		.mockRejectedValue(new Error("not mergeable"));

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequest,
			updateProjectIssueStatus,
			mergePullRequest,
			getPullRequestChangedFiles: async () => ["docs/guide.md"],
			loadPostRunDecisionConfig: async () =>
				buildPostRunPolicyLoadResult({
					auto_merge_eligible: [{ paths: ["docs/**"] }],
				}),
			getPullRequestCheckSummary: async () => ({
				classification: "checks_success",
				headSha: "sha-success",
				status: "success",
				checkRuns: [
					{
						name: "CI",
						status: "completed",
						conclusion: "success",
						detailsUrl: null,
					},
				],
			}),
		});

		expect(result.ok).toBe(true);
		expect(mergePullRequest).toHaveBeenCalledTimes(1);
		expect(updateProjectIssueStatus).not.toHaveBeenCalled();
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler does not mark Done when the pull request is already closed without merge", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 145,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#145";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "145",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/145",
	});
	const updateProjectIssueStatus = vi.fn();
	const getPullRequest = vi.fn().mockResolvedValue(
		buildPullRequestSummary({
			number: 145,
			state: "closed",
			merged: false,
		}),
	);
	const mergePullRequest = vi.fn();

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequest,
			updateProjectIssueStatus,
			mergePullRequest,
			getPullRequestChangedFiles: async () => ["docs/guide.md"],
			loadPostRunDecisionConfig: async () =>
				buildPostRunPolicyLoadResult({
					auto_merge_eligible: [{ paths: ["docs/**"] }],
				}),
			getPullRequestCheckSummary: async () => ({
				classification: "checks_success",
				headSha: "sha-success",
				status: "success",
				checkRuns: [
					{
						name: "CI",
						status: "completed",
						conclusion: "success",
						detailsUrl: null,
					},
				],
			}),
		});

		expect(result.ok).toBe(true);
		expect(mergePullRequest).not.toHaveBeenCalled();
		expect(updateProjectIssueStatus).not.toHaveBeenCalled();
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler runs post-PR curator and repairer planner for failed format checks", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 103,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#103";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "49",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/49",
	});

	try {
		const executeRepair = vi.fn().mockResolvedValue({
			executed: true,
			decisionId: "repair_decision",
			outcome: "repair_noop",
		});
		const runRepairerPlannerSpy = vi.fn().mockResolvedValue({
			workerRunId: "repair_planner_worker_run",
			decisionId: "repair_planner_decision",
			outcome: "repair_allowed",
			classification: "format_fixable",
			attemptCount: 0,
			attemptCounts: { headSha: 0, pullRequest: 0, fingerprint: 0 },
			maxAttempts: {
				headSha: 2,
				pullRequest: 6,
				fingerprint: 2,
			},
			repairExecutionKey: "107:abc123:shared",
			failureFingerprint: "format-failure",
		});
		const updateProjectIssueStatus = vi.fn();
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			runRepairerExecutor: executeRepair,
			runRepairerPlanner: runRepairerPlannerSpy,
			getPullRequestCheckSummary: async () => ({
				classification: "ci_failed",
				headSha: "abc123",
				status: "failure",
				checkRuns: [
					{
						name: "Format check",
						status: "completed",
						conclusion: "failure",
						detailsUrl:
							"https://github.com/toyamarinyon/rhapsody/actions/runs/1",
					},
				],
			}),
		});

		expect(result.ok).toBe(true);
		const graph = await listWorkItemGraph(client, workItemId);

		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "post_pr" && decision.outcome === "ci_failed",
			),
		).toBe(true);
		expect(runRepairerPlannerSpy).toHaveBeenCalledTimes(1);
		expect(executeRepair).toHaveBeenCalledTimes(1);
		expect(updateProjectIssueStatus).not.toHaveBeenCalled();
		expect(executeRepair).toHaveBeenCalledWith(
			expect.objectContaining({
				plan: expect.objectContaining({
					outcome: "repair_allowed",
				}),
			}),
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler posts a deduped mediated comment for repair_blocked post-PR checks", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 115,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#115";
	const pullRequestNumber = 215;
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: `${pullRequestNumber}`,
		externalUrl: `https://github.com/toyamarinyon/rhapsody/pull/${pullRequestNumber}`,
	});

	const checkSummary: PullRequestCheckSummary = {
		classification: "ci_failed",
		headSha: "sha-blocked",
		status: "failure",
		checkRuns: [
			{
				name: "Format check",
				status: "completed",
				conclusion: "failure",
				detailsUrl: "https://github.com/toyamarinyon/rhapsody/actions/runs/115",
				actions: {
					workflowRunId: 115,
					workflowName: "Format",
					jobId: 115,
					workflowPath: ".github/workflows/format.yml",
					jobName: "format",
					failedStepNames: ["Run prettier"],
				},
			},
		],
	};
	const repairExecutionKey = buildRepairExecutionKey({
		pullRequestNumber,
		headSha: checkSummary.headSha,
		failureFingerprint: buildFailureFingerprint(checkSummary),
	});
	const updateProjectIssueStatus = vi.fn().mockResolvedValue({
		projectId: "project",
		itemId: "item",
		fieldId: "field",
		optionId: "option",
		status: "Human Review",
	});
	const createIssueComment = vi.fn().mockResolvedValue({
		id: 115,
		htmlUrl:
			"https://github.com/toyamarinyon/rhapsody/issues/215#issuecomment-115",
	});
	const runRepairerPlannerSpy = vi.fn().mockResolvedValue({
		workerRunId: "repair_planner_worker_run",
		decisionId: "repair_planner_decision",
		outcome: "repair_blocked",
		classification: "not_deterministically_fixable",
		attemptCount: 0,
		attemptCounts: { headSha: 0, pullRequest: 0, fingerprint: 0 },
		maxAttempts: { headSha: 2, pullRequest: 6, fingerprint: 2 },
		repairExecutionKey,
		failureFingerprint: buildFailureFingerprint(checkSummary),
	});

	try {
		const firstResult = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			createIssueComment,
			runRepairerPlanner: runRepairerPlannerSpy,
			getPullRequestCheckSummary: async () => checkSummary,
		});

		expect(firstResult.ok).toBe(true);
		expect(createIssueComment).toHaveBeenCalledTimes(1);
		expect(createIssueComment).toHaveBeenCalledWith(
			expect.objectContaining({
				owner: "toyamarinyon",
				repository: "rhapsody",
				issueNumber: pullRequestNumber,
				body: expect.stringContaining(
					`Rhapsody evaluated auto-healing for PR #${pullRequestNumber} but did not start an automated repair.`,
				),
			}),
		);
		expect(createIssueComment.mock.calls[0]?.[0].body).toContain(
			"Reason: The failure did not match a repair path that Rhapsody can fix safely and deterministically.",
		);
		expect(createIssueComment.mock.calls[0]?.[0].body).toContain(
			"Triggered by: Format check / format / Run prettier",
		);
		expect(createIssueComment.mock.calls[0]?.[0].body).toContain(
			"Repair classification: not_deterministically_fixable",
		);
		expect(createIssueComment.mock.calls[0]?.[0].body).toContain(
			"Failure fingerprint:",
		);

		const secondResult = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			createIssueComment,
			runRepairerPlanner: runRepairerPlannerSpy,
			getPullRequestCheckSummary: async () => checkSummary,
		});

		expect(secondResult.ok).toBe(true);
		expect(createIssueComment).toHaveBeenCalledTimes(1);

		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.artifacts.filter(
				(artifact) => artifact.kind === "repair_blocked_comment",
			),
		).toHaveLength(1);
		expect(
			graph.artifacts.find(
				(artifact) => artifact.kind === "repair_blocked_comment",
			)?.metadata,
		).toEqual(
			expect.objectContaining({
				pullRequestNumber,
				repairClassification: "not_deterministically_fixable",
				repairExecutionKey,
			}),
		);
		expect(updateProjectIssueStatus).toHaveBeenCalled();
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler prefers integration repair before CI repair when the PR branch is behind base", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 111,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#111";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "111",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/111",
	});

	try {
		const runIntegrationRepairPlannerSpy = vi.fn().mockResolvedValue({
			workerRunId: "integration-planner-run",
			decisionId: "integration-planner-decision",
			outcome: "integration_repair_needed",
			skippedFreshDuplicate: false,
			integrationExecutionKey: "111:head-sha:base-sha",
			headSha: "head-sha",
			baseSha: "base-sha",
			branchComparison: {
				base: "main",
				head: "feature",
				status: "behind",
				aheadBy: 0,
				behindBy: 2,
				mergeBaseCommitSha: "base-sha",
			},
		});
		const runIntegrationRepairExecutorSpy = vi.fn().mockResolvedValue({
			executed: true,
			outcome: "integration_repair_applied",
		});
		const runRepairerPlannerSpy = vi.fn();
		const runRepairerExecutorSpy = vi.fn();
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequest: async () => ({
				reused: true,
				number: 111,
				htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/111",
				headRef: "feature",
				headSha: "head-sha",
				baseRef: "main",
				baseSha: "base-sha",
				title: "Feature",
				sha: "head-sha",
			}),
			getPullRequestCheckSummary: async () => ({
				classification: "ci_failed",
				headSha: "head-sha",
				status: "failure",
				checkRuns: [
					{
						name: "Format check",
						status: "completed",
						conclusion: "failure",
						detailsUrl:
							"https://github.com/toyamarinyon/rhapsody/actions/runs/1",
					},
				],
			}),
			comparePullRequestBranches: async () => ({
				base: "main",
				head: "feature",
				status: "behind",
				aheadBy: 0,
				behindBy: 2,
				mergeBaseCommitSha: "base-sha",
			}),
			runIntegrationRepairPlanner: runIntegrationRepairPlannerSpy,
			runIntegrationRepairExecutor: runIntegrationRepairExecutorSpy,
			runRepairerPlanner: runRepairerPlannerSpy,
			runRepairerExecutor: runRepairerExecutorSpy,
		});

		expect(result.ok).toBe(true);
		expect(runIntegrationRepairPlannerSpy).toHaveBeenCalledTimes(1);
		expect(runIntegrationRepairExecutorSpy).toHaveBeenCalledTimes(1);
		expect(runRepairerPlannerSpy).not.toHaveBeenCalled();
		expect(runRepairerExecutorSpy).not.toHaveBeenCalled();
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler prefers integration repair before Human Review when unknown checks are behind base", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 112,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#112";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "112",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/112",
	});

	try {
		const updateProjectIssueStatus = vi.fn();
		const runIntegrationRepairPlannerSpy = vi.fn().mockResolvedValue({
			workerRunId: "integration-planner-run",
			decisionId: "integration-planner-decision",
			outcome: "integration_repair_needed",
			skippedFreshDuplicate: false,
			integrationExecutionKey: "112:head-sha:base-sha",
			headSha: "head-sha",
			baseSha: "base-sha",
			branchComparison: {
				base: "main",
				head: "feature",
				status: "behind",
				aheadBy: 0,
				behindBy: 1,
				mergeBaseCommitSha: "merge-base-sha",
			},
		});
		const runIntegrationRepairExecutorSpy = vi.fn().mockResolvedValue({
			executed: true,
			outcome: "integration_repair_applied",
		});
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			getPullRequest: async () => ({
				reused: true,
				number: 112,
				htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/112",
				headRef: "feature",
				headSha: "head-sha",
				baseRef: "main",
				baseSha: "base-sha",
				title: "Feature",
				sha: "head-sha",
			}),
			getPullRequestCheckSummary: async () => ({
				classification: "checks_unknown",
				headSha: "head-sha",
				status: "unknown",
				checkRuns: [],
			}),
			comparePullRequestBranches: async () => ({
				base: "main",
				head: "feature",
				status: "behind",
				aheadBy: 0,
				behindBy: 1,
				mergeBaseCommitSha: "merge-base-sha",
			}),
			runIntegrationRepairPlanner: runIntegrationRepairPlannerSpy,
			runIntegrationRepairExecutor: runIntegrationRepairExecutorSpy,
		});

		expect(result.ok).toBe(true);
		expect(runIntegrationRepairPlannerSpy).toHaveBeenCalledTimes(1);
		expect(runIntegrationRepairExecutorSpy).toHaveBeenCalledTimes(1);
		expect(updateProjectIssueStatus).not.toHaveBeenCalled();
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler routes unresolved integration conflicts to Human Review with evidence", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 113,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#113";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "113",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/113",
	});

	try {
		const updateProjectIssueStatus = vi.fn().mockResolvedValue({
			projectId: "project",
			itemId: "item",
			fieldId: "field",
			optionId: "option",
			status: "Human Review",
		});
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			updateProjectIssueStatus,
			getPullRequest: async () => ({
				reused: true,
				number: 113,
				htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/113",
				headRef: "feature",
				headSha: "head-sha",
				baseRef: "main",
				baseSha: "base-sha",
				title: "Feature",
				sha: "head-sha",
			}),
			getPullRequestCheckSummary: async () => ({
				classification: "ci_failed",
				headSha: "head-sha",
				status: "failure",
				checkRuns: [
					{
						name: "Format check",
						status: "completed",
						conclusion: "failure",
						detailsUrl:
							"https://github.com/toyamarinyon/rhapsody/actions/runs/1",
					},
				],
			}),
			comparePullRequestBranches: async () => ({
				base: "main",
				head: "feature",
				status: "behind",
				aheadBy: 0,
				behindBy: 1,
				mergeBaseCommitSha: "merge-base-sha",
			}),
			runIntegrationRepairPlanner: async () => ({
				workerRunId: "integration-planner-run",
				decisionId: "integration-planner-decision",
				outcome: "integration_repair_needed",
				skippedFreshDuplicate: false,
				integrationExecutionKey: "113:head-sha:base-sha",
				headSha: "head-sha",
				baseSha: "base-sha",
				branchComparison: {
					base: "main",
					head: "feature",
					status: "behind",
					aheadBy: 0,
					behindBy: 1,
					mergeBaseCommitSha: "merge-base-sha",
				},
			}),
			runIntegrationRepairExecutor: async () => ({
				executed: true,
				decisionId: "dec_integration_unresolved",
				outcome: "integration_repair_conflict_unresolved",
				reason: "conflicts remained after conflict resolution",
			}),
		});

		expect(result.ok).toBe(true);
		expect(updateProjectIssueStatus).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "Human Review",
			}),
		);
		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "post_pr" && decision.outcome === "human_review",
			),
		).toBe(true);
		const resolutionDecision = graph.decisions.find(
			(decision) =>
				decision.phase === "post_pr" && decision.outcome === "human_review",
		);
		expect(resolutionDecision?.evidence).toEqual(
			expect.objectContaining({
				checkClassification: "ci_failed",
				integrationDecisionId: "dec_integration_unresolved",
			}),
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler keeps existing CI repair path available after integration says branch is current", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 114,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#114";
	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: "114",
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/114",
	});

	try {
		const runRepairerPlannerSpy = vi.fn().mockResolvedValue({
			workerRunId: "repair-planner-run",
			decisionId: "repair-planner-decision",
			outcome: "repair_allowed",
			classification: "format_fixable",
			attemptCount: 0,
			attemptCounts: { headSha: 0, pullRequest: 0, fingerprint: 0 },
			maxAttempts: { headSha: 2, pullRequest: 6, fingerprint: 2 },
			repairExecutionKey: "114:head-sha:fingerprint",
			failureFingerprint: "fingerprint",
		});
		const runRepairerExecutorSpy = vi.fn().mockResolvedValue({
			executed: true,
			outcome: "repair_noop",
		});
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequest: async () => ({
				reused: true,
				number: 114,
				htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/114",
				headRef: "feature",
				headSha: "head-sha",
				baseRef: "main",
				baseSha: "base-sha",
				title: "Feature",
				sha: "head-sha",
			}),
			getPullRequestCheckSummary: async () => ({
				classification: "ci_failed",
				headSha: "head-sha",
				status: "failure",
				checkRuns: [
					{
						name: "Format check",
						status: "completed",
						conclusion: "failure",
						detailsUrl:
							"https://github.com/toyamarinyon/rhapsody/actions/runs/1",
					},
				],
			}),
			comparePullRequestBranches: async () => ({
				base: "main",
				head: "feature",
				status: "ahead",
				aheadBy: 1,
				behindBy: 0,
				mergeBaseCommitSha: "merge-base-sha",
			}),
			runIntegrationRepairPlanner: async () => ({
				workerRunId: "integration-planner-run",
				decisionId: "integration-planner-decision",
				outcome: "integration_repair_current",
				skippedFreshDuplicate: false,
				integrationExecutionKey: "114:head-sha:base-sha",
				headSha: "head-sha",
				baseSha: "base-sha",
				branchComparison: {
					base: "main",
					head: "feature",
					status: "ahead",
					aheadBy: 1,
					behindBy: 0,
					mergeBaseCommitSha: "merge-base-sha",
				},
			}),
			runRepairerPlanner: runRepairerPlannerSpy,
			runRepairerExecutor: runRepairerExecutorSpy,
		});

		expect(result.ok).toBe(true);
		expect(runRepairerPlannerSpy).toHaveBeenCalledTimes(1);
		expect(runRepairerExecutorSpy).toHaveBeenCalledTimes(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler executes unexecuted repair_allowed from fresh post-PR duplicate", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 107,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#107";
	const plannerDecisionId = "repair_planner_decision";
	const pullRequestNumber = 107;
	const headSha = "sha-dup";
	const checkSummary: PullRequestCheckSummary = {
		classification: "ci_failed",
		headSha,
		status: "failure",
		checkRuns: [
			{
				name: "format check",
				status: "completed",
				conclusion: "failure",
				detailsUrl: "https://example.com/check",
			},
		],
	};
	const failureFingerprint = buildFailureFingerprint(checkSummary);
	const repairExecutionKey = buildRepairExecutionKey({
		pullRequestNumber,
		headSha,
		failureFingerprint,
	});

	const postPrRun = await createWorkerRun(client, {
		id: "post_pr_run",
		workItemId,
		kind: "post_pr_curator",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: postPrRun.id,
		kind: "pull_request",
		externalId: `${pullRequestNumber}`,
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/107",
	});
	await createDecision(client, {
		id: "post_pr_decision",
		workItemId,
		workerRunId: postPrRun.id,
		phase: "post_pr",
		outcome: "ci_failed",
		evidence: {
			pullRequestNumber,
			checks: {
				headSha,
				classification: "ci_failed",
			},
		},
	});
	await createWorkerRun(client, {
		id: "repair-planner-run",
		workItemId,
		kind: "repairer",
		status: "completed",
	});
	await createDecision(client, {
		id: plannerDecisionId,
		workItemId,
		workerRunId: "repair-planner-run",
		phase: "repair",
		outcome: "repair_allowed",
		evidence: {
			pullRequestNumber,
			classification: "format_fixable",
			failureFingerprint,
			repairExecutionKey,
			checkSummary,
			checks: {
				headSha,
			},
			attemptCounts: {
				headSha: 0,
				pullRequest: 0,
				fingerprint: 0,
			},
			maxAttempts: {
				headSha: 2,
				pullRequest: 6,
				fingerprint: 2,
			},
		},
	});

	const executeRepair = vi.fn().mockResolvedValue({
		executed: true,
		outcome: "repair_noop",
		decisionId: "repair_decision",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: {
				...baseConfig,
				tracker: {
					...baseConfig.tracker,
					activeStatuses: ["In Progress"],
				},
			},
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequestCheckSummary: async () => checkSummary,
			runRepairerExecutor: executeRepair,
			runRepairerPlanner: runRepairerPlanner,
		});

		expect(result.ok).toBe(true);
		expect(executeRepair).toHaveBeenCalledTimes(1);
		const call = executeRepair.mock.calls[0]?.[0];
		expect(call?.plan.decisionId).toBeTypeOf("string");
		expect(call?.plan.repairExecutionKey).toBe(repairExecutionKey);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler does not retry fresh duplicate if repair attempts hit fingerprint budget", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 107,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#107";
	const pullRequestNumber = 107;
	const headSha = "sha-dup-2";
	const checkSummary: PullRequestCheckSummary = {
		classification: "ci_failed",
		headSha,
		status: "failure",
		checkRuns: [
			{
				name: "format check",
				status: "completed",
				conclusion: "failure",
				detailsUrl: "https://example.com/check",
			},
		],
	};
	const failureFingerprint = buildFailureFingerprint(checkSummary);
	const repairExecutionKey = buildRepairExecutionKey({
		pullRequestNumber,
		headSha,
		failureFingerprint,
	});

	const postPrRun = await createWorkerRun(client, {
		id: "post_pr_run_blocked",
		workItemId,
		kind: "post_pr_curator",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: postPrRun.id,
		kind: "pull_request",
		externalId: `${pullRequestNumber}`,
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/107",
	});
	await createDecision(client, {
		id: "post_pr_decision_blocked",
		workItemId,
		workerRunId: postPrRun.id,
		phase: "post_pr",
		outcome: "ci_failed",
		evidence: {
			pullRequestNumber,
			checks: {
				headSha,
				classification: "ci_failed",
			},
		},
	});
	await createWorkerRun(client, {
		id: "repair-planner-run-blocked",
		workItemId,
		kind: "repairer",
		status: "completed",
	});
	await createDecision(client, {
		id: "repair_allowed_blocked",
		workItemId,
		workerRunId: "repair-planner-run-blocked",
		phase: "repair",
		outcome: "repair_allowed",
		evidence: {
			pullRequestNumber,
			classification: "format_fixable",
			failureFingerprint,
			repairExecutionKey,
			checkSummary,
			checks: {
				headSha,
			},
		},
	});

	for (let index = 0; index < 2; index += 1) {
		await createWorkerRun(client, {
			id: `repair-failed-${index}`,
			workItemId,
			kind: "repairer",
			status: "failed",
		});
		await createDecision(client, {
			id: `repair_failed_${index}`,
			workItemId,
			workerRunId: `repair-failed-${index}`,
			phase: "repair",
			outcome: "repair_failed",
			policyRuleId: "format_fixable",
			evidence: {
				pullRequestNumber,
				classification: "format_fixable",
				failureFingerprint,
				repairExecutionKey,
				checkSummary,
				checks: {
					headSha,
				},
			},
		});
	}

	const executeRepair = vi.fn().mockResolvedValue({
		executed: false,
		outcome: "repair_skipped_terminal",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequestCheckSummary: async () => checkSummary,
			runRepairerExecutor: executeRepair,
		});

		expect(result.ok).toBe(true);
		expect(executeRepair).toHaveBeenCalledTimes(0);
	} finally {
		client.close();
		database.cleanup();
	}
});

test.each([
	"pending",
	"running",
] as const)("scheduler does not re-start repair while previous repair run is active (%s)", async (repairerRunStatus) => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 108,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#108";
	const pullRequestNumber = 108;
	const headSha = "sha-active";
	const checkSummary: PullRequestCheckSummary = {
		classification: "ci_failed",
		headSha,
		status: "failure",
		checkRuns: [
			{
				name: "prettier",
				status: "completed",
				conclusion: "failure",
				detailsUrl: "https://example.com/check",
			},
		],
	};
	const failureFingerprint = buildFailureFingerprint(checkSummary);
	const repairExecutionKey = buildRepairExecutionKey({
		pullRequestNumber,
		headSha,
		failureFingerprint,
	});

	const postPrRun = await createWorkerRun(client, {
		id: "post_pr_run_active",
		workItemId,
		kind: "post_pr_curator",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: postPrRun.id,
		kind: "pull_request",
		externalId: `${pullRequestNumber}`,
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/108",
	});
	await createDecision(client, {
		id: "post_pr_decision_active",
		workItemId,
		workerRunId: postPrRun.id,
		phase: "post_pr",
		outcome: "ci_failed",
		evidence: { pullRequestNumber, checks: { headSha } },
	});
	await createWorkerRun(client, {
		id: "repair-planner-run-active",
		workItemId,
		kind: "repairer",
		status: "completed",
	});
	await createDecision(client, {
		id: "repair_allowed_active",
		workItemId,
		workerRunId: "repair-planner-run-active",
		phase: "repair",
		outcome: "repair_allowed",
		evidence: {
			pullRequestNumber,
			classification: "format_fixable",
			failureFingerprint,
			repairExecutionKey,
			checkSummary,
			checks: { headSha },
		},
	});
	await createWorkerRun(client, {
		workItemId,
		kind: "repairer",
		status: repairerRunStatus,
		metadata: { repairExecutionKey },
	});

	const executeRepair = vi.fn().mockResolvedValue({
		executed: false,
		outcome: "repair_skipped_in_progress",
	});
	const plannerSpy = vi.fn().mockResolvedValue({
		workerRunId: "repair-planner-run-active",
		decisionId: "repair_allowed_active",
		outcome: "repair_allowed",
		classification: "format_fixable",
		attemptCount: 0,
		attemptCounts: { headSha: 0, pullRequest: 1, fingerprint: 1 },
		maxAttempts: {
			headSha: 2,
			pullRequest: 6,
			fingerprint: 2,
		},
		repairExecutionKey,
		failureFingerprint,
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequestCheckSummary: async () => checkSummary,
			runRepairerPlanner: plannerSpy,
			runRepairerExecutor: executeRepair,
		});

		expect(result.ok).toBe(true);
		expect(plannerSpy).toHaveBeenCalledTimes(0);
		expect(executeRepair).toHaveBeenCalledTimes(0);
	} finally {
		client.close();
		database.cleanup();
	}
});
test("scheduler skips terminal repair execution for same execution key", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 110,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#110";
	const pullRequestNumber = 110;
	const headSha = "sha-terminal-skip";
	const checkSummary: PullRequestCheckSummary = {
		classification: "ci_failed",
		headSha,
		status: "failure",
		checkRuns: [
			{
				name: "format check",
				status: "completed",
				conclusion: "failure",
				detailsUrl: "https://example.com/check",
			},
		],
	};
	const failureFingerprint = buildFailureFingerprint(checkSummary);
	const repairExecutionKey = buildRepairExecutionKey({
		pullRequestNumber,
		headSha,
		failureFingerprint,
	});

	await createWorkerRun(client, {
		id: "post_pr_terminal_skip",
		workItemId,
		kind: "post_pr_curator",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: "post_pr_terminal_skip",
		kind: "pull_request",
		externalId: `${pullRequestNumber}`,
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/110",
	});
	await createDecision(client, {
		id: "post_pr_terminal_skip",
		workItemId,
		workerRunId: "post_pr_terminal_skip",
		phase: "post_pr",
		outcome: "ci_failed",
		evidence: {
			pullRequestNumber,
			checks: {
				headSha: "different-head",
				classification: "ci_failed",
			},
		},
	});
	await createWorkerRun(client, {
		id: "repairer_terminal_run",
		workItemId,
		kind: "repairer",
		status: "completed",
	});
	await createDecision(client, {
		id: "repair_noop_terminal",
		workItemId,
		workerRunId: "repairer_terminal_run",
		phase: "repair",
		outcome: "repair_noop",
		evidence: {
			pullRequestNumber,
			classification: "format_fixable",
			failureFingerprint,
			repairExecutionKey,
			checks: { headSha },
		},
	});

	const executeRepair = vi.fn().mockResolvedValue({
		executed: false,
		outcome: "repair_skipped_terminal",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequestCheckSummary: async () => checkSummary,
			runRepairerExecutor: executeRepair,
		});

		expect(result.ok).toBe(true);
		expect(executeRepair).toHaveBeenCalledTimes(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler retries scheduling after a prior failed repair attempt", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 109,
		projectStatus: "In Progress",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#109";
	const pullRequestNumber = 109;
	const headSha = "sha-retry";
	const checkSummary: PullRequestCheckSummary = {
		classification: "ci_failed",
		headSha,
		status: "failure",
		checkRuns: [
			{
				name: "prettier",
				status: "completed",
				conclusion: "failure",
				detailsUrl: "https://example.com/check",
			},
		],
	};
	const failureFingerprint = buildFailureFingerprint(checkSummary);

	const builderRun = await createWorkerRun(client, {
		workItemId,
		kind: "builder",
		status: "completed",
	});
	await createArtifact(client, {
		workItemId,
		workerRunId: builderRun.id,
		kind: "pull_request",
		externalId: `${pullRequestNumber}`,
		externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/109",
	});
	await createWorkerRun(client, {
		id: "retry-run",
		workItemId,
		kind: "repairer",
		status: "failed",
	});
	await createDecision(client, {
		id: "repair_failed_retry",
		workItemId,
		workerRunId: "retry-run",
		phase: "repair",
		outcome: "repair_failed",
		evidence: {
			pullRequestNumber,
			classification: "format_fixable",
			failureFingerprint,
			checkSummary,
			repairExecutionKey: `${pullRequestNumber}:${headSha}:${failureFingerprint}`,
			checks: { headSha },
			attemptCounts: {
				headSha: 1,
				pullRequest: 1,
				fingerprint: 1,
			},
			maxAttempts: {
				headSha: 2,
				pullRequest: 6,
				fingerprint: 2,
			},
		},
	});

	const executeRepair = vi
		.fn()
		.mockResolvedValue({ executed: true, outcome: "repair_failed" });
	const plannerSpy = vi.fn().mockResolvedValue({
		workerRunId: "retry-run",
		decisionId: "repair_failed_retry",
		outcome: "repair_allowed",
		classification: "format_fixable",
		attemptCount: 1,
		attemptCounts: {
			headSha: 1,
			pullRequest: 1,
			fingerprint: 1,
		},
		maxAttempts: {
			headSha: 2,
			pullRequest: 6,
			fingerprint: 2,
		},
		repairExecutionKey: `${pullRequestNumber}:${headSha}:${failureFingerprint}`,
		failureFingerprint,
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			getPullRequestCheckSummary: async () => checkSummary,
			runRepairerPlanner: plannerSpy,
			runRepairerExecutor: executeRepair,
		});

		expect(result.ok).toBe(true);
		expect(executeRepair).toHaveBeenCalledTimes(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler skips Todo items when concurrency limit is exhausted", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 105,
		projectStatus: "Todo",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#105";

	await createClaimedManualRun(client, {
		workItemId: `${workItemId}-other`,
		workItemTitle: "Other claim",
		claimedBy: "scheduler",
		workItemStatus: "OPEN",
		runner: "sandbox-codex",
		claimTtlMs: 60_000,
		claimToken: "active-token",
		runId: "run_other",
		attemptId: "attempt_other",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: normalizeProjectConfig({
				...baseConfig,
				runner: {
					kind: baseConfig.runner.kind,
					timeoutMs: baseConfig.runner.timeoutMs,
				},
				scheduler: {
					...baseConfig.scheduler,
					maxConcurrentRuns: 1,
				},
			}),
			fetchProjectIssueWorkItems: async () => [item],
			runIntakeCurator: runBuildableIntakeCurator,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		expect(result.value.created).toBe(0);
		expect(result.value.skippedIssues).toEqual([
			{
				workItemId,
				issueNumber: 105,
				reason: "concurrencyLimit",
			},
		]);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("scheduler skips Todo items with an active claim on same work item", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const item = buildProjectItem({
		issueNumber: 106,
		projectStatus: "Todo",
	});
	const workItemId = "github_issue:toyamarinyon/rhapsody#106";
	const existingRunId = "run_existing";
	await createClaimedManualRun(client, {
		workItemId,
		workItemTitle: "Claimed issue",
		claimedBy: "other",
		workItemStatus: "OPEN",
		runner: "sandbox-codex",
		claimTtlMs: 60_000,
		claimToken: "claim-existing",
		runId: existingRunId,
		attemptId: "attempt_existing",
	});

	try {
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
			runIntakeCurator: runBuildableIntakeCurator,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) {
			return;
		}

		expect(result.value.created).toBe(0);
		expect(result.value.skippedIssues).toEqual([
			{
				workItemId,
				issueNumber: 106,
				reason: "alreadyClaimed",
				existingRunId,
			},
		]);
	} finally {
		client.close();
		database.cleanup();
	}
});

async function createTestDatabase(): Promise<{
	client: Client;
	cleanup: () => void;
}> {
	const directory = mkdtempSync(path.join(tmpdir(), "rhapsody-test-"));
	const client = createClient({
		url: `file:${path.join(directory, "state.db")}`,
	});
	await migrateStateStore(client);
	return {
		client,
		cleanup: () => rmSync(directory, { force: true, recursive: true }),
	};
}

function buildProjectItem(input: {
	issueNumber: number;
	projectStatus: string;
	issueBody?: string | null;
}): GitHubProjectIssueWorkItem {
	return {
		issueNumber: input.issueNumber,
		issueTitle: `Issue ${input.issueNumber}`,
		issueUrl: `https://github.com/toyamarinyon/rhapsody/issues/${input.issueNumber}`,
		issueState: "OPEN",
		issueBody:
			input.issueBody ??
			"Please move this issue forward with a small focused implementation.",
		projectStatus: input.projectStatus,
		blockedBy: [],
		projectFields: {},
		repository: {
			owner: "toyamarinyon",
			name: "rhapsody",
		},
	};
}

function buildPullRequestSummary(input: {
	number: number;
	state?: "open" | "closed";
	merged?: boolean;
	mergedAt?: string | null;
}) {
	return {
		reused: true,
		number: input.number,
		htmlUrl: `https://github.com/toyamarinyon/rhapsody/pull/${input.number}`,
		headRef: `rhapsody/issue-${input.number}`,
		baseRef: "main",
		title: `PR ${input.number}`,
		state: input.state ?? "open",
		merged: input.merged ?? false,
		mergedAt: input.mergedAt ?? null,
	};
}

const runBuildableIntakeCurator: typeof runIntakeCurator = (
	client,
	workItem,
	workItemId,
	options,
) =>
	runIntakeCurator(client, workItem, workItemId, {
		...options,
		dependencies: {
			...options?.dependencies,
			fetchBlockedBy: async () => [],
		},
		classify: async () => ({
			classification: {
				decision: "buildable",
				summary: "Ready to build.",
				implementation_plan:
					"Implement the requested change with a focused patch.",
				comment: "I will implement this with a focused patch.",
				next_action: "start_builder",
			},
			raw: "{}",
			command: "mock",
		}),
		comment: async (comment) => ({
			id: comment.issueNumber,
			htmlUrl: `${comment.owner}/${comment.repository}#${comment.issueNumber}`,
		}),
	});

const runAskHumanIntakeCurator: typeof runIntakeCurator = (
	client,
	workItem,
	workItemId,
	options,
) =>
	runIntakeCurator(client, workItem, workItemId, {
		...options,
		dependencies: {
			...options?.dependencies,
			fetchBlockedBy: async () => [],
		},
		classify: async () => ({
			classification: {
				decision: "ask_human",
				summary: "Needs clarification.",
				question: "What should Rhapsody change?",
				comment: "Please clarify the expected change before implementation.",
				next_action: "add_context_and_acceptance_criteria",
			},
			raw: "{}",
			command: "mock",
		}),
		comment: async (comment) => ({
			id: comment.issueNumber,
			htmlUrl: `${comment.owner}/${comment.repository}#${comment.issueNumber}`,
		}),
	});
