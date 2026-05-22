import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { expect, test, vi } from "vitest";
import type { PullRequestCheckSummary } from "@/lib/github/checks";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";
import {
	createArtifact,
	createClaimedManualRun,
	createDecision,
	createWorkerRun,
	listWorkItemGraph,
	migrateStateStore,
} from "@/lib/state";
import { runIntakeCurator } from "@/lib/workers/intake-curator";
import {
	buildFailureFingerprint,
	buildRepairExecutionKey,
	runRepairerPlanner,
} from "@/lib/workers/repairer";
import { runSchedulerTick, type SchedulerTickDependencies } from "./tick";

const baseConfig: SchedulerTickDependencies["config"] = {
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
		claimTtlMs: 60_000,
		maxRetryBackoffMs: 300_000,
		runningAttemptTimeoutMs: 60_000,
	},
	runner: "sandbox-codex",
};

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
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
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

test("scheduler does not re-start repair while previous repair run is active", async () => {
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
		status: "running",
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
		expect(executeRepair).toHaveBeenCalledTimes(1);
		const resultArg = executeRepair.mock.calls[0]?.[0] as Record<
			"plan",
			{ repairExecutionKey: string }
		>;
		expect(resultArg?.plan?.repairExecutionKey).toBe(
			buildRepairExecutionKey({
				pullRequestNumber: 108,
				headSha,
				failureFingerprint,
			}),
		);
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
			config: {
				...baseConfig,
				scheduler: {
					...baseConfig.scheduler,
					maxConcurrentRuns: 0,
				},
			},
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
