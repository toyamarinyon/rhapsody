import { expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

import {
	createDecision,
	createWorkerRun,
	listWorkItemGraph,
	migrateStateStore,
} from "@/lib/state";
import {
	runPostPrCurator,
	runHumanReviewMonitoring,
	findPullRequestArtifactFromArtifacts,
} from "@/lib/workers/post-pr-curator";

test("runPostPrCurator dedupes by PR number, classification, and head SHA", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#311";

	try {
		const workerRun = await createWorkerRun(client, {
			id: "wrn_post_pr",
			workItemId,
			kind: "post_pr_curator",
			status: "completed",
		});

		await createDecision(client, {
			id: "dec_post_pr",
			workItemId,
			workerRunId: workerRun.id,
			phase: "post_pr",
			outcome: "ci_failed",
			evidence: {
				pullRequestNumber: 77,
				checks: {
					headSha: "sha-77",
					classification: "ci_failed",
				},
			},
		});

		const result = await runPostPrCurator(client, {
			workItem: buildProjectItem(77),
			workItemId,
			owner: "toyamarinyon",
			repository: "rhapsody",
			pullRequestNumber: 77,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/77",
			existingDecisions: [
				{
					id: "dec_post_pr",
					workItemId,
					workerRunId: workerRun.id,
					phase: "post_pr",
					outcome: "ci_failed",
					deterministic: true,
					policyVersion: null,
					policyRuleId: null,
					evidence: {
						pullRequestNumber: 77,
						checks: {
							headSha: "sha-77",
							classification: "ci_failed",
						},
					},
					nextWorkerKind: null,
					nextAction: null,
					createdAt: 1,
					updatedAt: 1,
				},
			],
			getPullRequestCheckSummary: async () => ({
				classification: "ci_failed",
				headSha: "sha-77",
				status: "failure",
				checkRuns: [],
			}),
		});

		expect(result.decisionId).toBe("dec_post_pr");
		expect(result.skippedFreshDuplicate).toBe(true);
		expect(result.workerRunId).toBeNull();

		const graph = await listWorkItemGraph(client, workItemId);
		expect(graph.decisions).toHaveLength(1);
		expect(graph.workerRuns).toHaveLength(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runPostPrCurator creates a fresh decision when head SHA changes", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#313";

	try {
		const workerRun = await createWorkerRun(client, {
			id: "wrn_post_pr_stale",
			workItemId,
			kind: "post_pr_curator",
			status: "completed",
		});

		await createDecision(client, {
			id: "dec_post_pr_stale",
			workItemId,
			workerRunId: workerRun.id,
			phase: "post_pr",
			outcome: "ci_failed",
			evidence: {
				pullRequestNumber: 313,
				checks: {
					headSha: "sha-old",
					classification: "ci_failed",
				},
			},
		});

		const result = await runPostPrCurator(client, {
			workItem: buildProjectItem(313),
			workItemId,
			owner: "toyamarinyon",
			repository: "rhapsody",
			pullRequestNumber: 313,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/313",
			existingDecisions: [
				{
					id: "dec_post_pr_stale",
					workItemId,
					workerRunId: workerRun.id,
					phase: "post_pr",
					outcome: "ci_failed",
					deterministic: true,
					policyVersion: null,
					policyRuleId: null,
					evidence: {
						pullRequestNumber: 313,
						checks: {
							headSha: "sha-old",
							classification: "ci_failed",
						},
					},
					nextWorkerKind: null,
					nextAction: null,
					createdAt: 1,
					updatedAt: 1,
				},
			],
			getPullRequestCheckSummary: async () => ({
				classification: "ci_failed",
				headSha: "sha-new",
				status: "failure",
				checkRuns: [],
			}),
		});

		expect(result.skippedFreshDuplicate).toBe(false);
		expect(result.classification).toBe("ci_failed");
		expect(result.decisionId).not.toBe("dec_post_pr_stale");
		expect(result.workerRunId).not.toBeNull();

		const graph = await listWorkItemGraph(client, workItemId);
		expect(graph.decisions).toHaveLength(2);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runPostPrCurator creates decision and evaluates link with parsed metadata", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#312";

	try {
		const result = await runPostPrCurator(client, {
			workItem: buildProjectItem(312),
			workItemId,
			owner: "toyamarinyon",
			repository: "rhapsody",
			pullRequestNumber: 312,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/312",
			getPullRequestCheckSummary: async () => ({
				classification: "checks_pending",
				headSha: "sha-312",
				status: "pending",
				checkRuns: [
					{ name: "ci", status: "queued", conclusion: null, detailsUrl: null },
				],
			}),
		});

		expect(result.skippedFreshDuplicate).toBe(false);
		expect(result.classification).toBe("checks_pending");

		const graph = await listWorkItemGraph(client, workItemId);
		expect(graph.workerRuns).toHaveLength(1);
		expect(graph.decisions).toHaveLength(1);
		expect(graph.decisions[0]?.phase).toBe("post_pr");
		expect(graph.decisions[0]?.evidence).toEqual(
			expect.objectContaining({
				pullRequestNumber: 312,
				checks: {
					classification: "checks_pending",
					headSha: "sha-312",
					status: "pending",
					checkRuns: [
						{
							name: "ci",
							status: "queued",
							conclusion: null,
							detailsUrl: null,
						},
					],
				},
			}),
		);
		const createdLink = graph.links.find(
			(link) => link.relation === "evaluates",
		);
		expect(createdLink).toEqual(
			expect.objectContaining({
				relation: "evaluates",
				metadata: {
					checkClassification: "checks_pending",
				},
			}),
		);
		expect(createdLink?.toNodeType).toBe("decision");

		expect(
			findPullRequestArtifactFromArtifacts([
				{
					id: "x",
					kind: "pull_request",
					externalId: "312",
					externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/312",
					createdAt: 1,
				},
			]),
		).toEqual({
			id: "x",
			number: 312,
			url: "https://github.com/toyamarinyon/rhapsody/pull/312",
		});

		expect(
			findPullRequestArtifactFromArtifacts([
				{
					id: "y",
					kind: "pull_request",
					externalId: null,
					externalUrl: "https://github.com/toyamarinyon/rhapsody/pull/321",
					createdAt: 2,
				},
			]),
		).toBeNull();
		expect(
			findPullRequestArtifactFromArtifacts([
				{
					id: "z",
					kind: "pull_request",
					externalId: "not-a-number",
					externalUrl: null,
					createdAt: 3,
				},
			]),
		).toBeNull();
		expect(
			findPullRequestArtifactFromArtifacts([
				{
					id: "w",
					kind: "pull_request",
					externalId: "314",
					externalUrl: null,
					createdAt: 4,
				},
			]),
		).toEqual({
			id: "w",
			number: 314,
			url: null,
		});
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runHumanReviewMonitoring records blocked Human Review evidence without regressing status", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#314";
	const postPrWorkerRun = await createWorkerRun(client, {
		id: "wrn_post_pr_monitor",
		workItemId,
		kind: "post_pr_curator",
		status: "completed",
	});
	await createDecision(client, {
		id: "dec_post_pr_monitor",
		workItemId,
		workerRunId: postPrWorkerRun.id,
		phase: "post_pr",
		outcome: "human_review",
		now: 1,
		evidence: {
			pullRequestNumber: 314,
			baseSha: "base-old",
			headSha: "head-old",
			checkClassification: "checks_success",
		},
	});
	const existingDecisions = (await listWorkItemGraph(client, workItemId)).decisions;
	const createIssueComment = vi.fn().mockResolvedValue({
		id: 10,
		htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/314#issuecomment-10",
	});

	try {
		const result = await runHumanReviewMonitoring(client, {
			workItem: buildProjectItem(314),
			workItemId,
			owner: "toyamarinyon",
			repository: "rhapsody",
			pullRequestArtifact: {
				number: 314,
				url: "https://github.com/toyamarinyon/rhapsody/pull/314",
			},
			existingDecisions,
			postRunPolicy: {
				auto_merge_eligible: [],
				auto_merge_success_status: "Done",
				human_review_status: "Human Review",
				human_review_monitoring: {
					enabled: true,
					auto_integrate_base_before_human_activity: true,
					auto_integrate_base_after_human_activity: false,
					comment_on_conflict: true,
				},
			},
			getPullRequest: async () => ({
				reused: true,
				number: 314,
				htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/314",
				headRef: "feature",
				baseRef: "main",
				headSha: "head-new",
				baseSha: "base-new",
				title: "Review me",
			}),
			getPullRequestCheckSummary: async () => ({
				classification: "ci_failed",
				headSha: "head-new",
				status: "failure",
				checkRuns: [],
			}),
			comparePullRequestBranches: async () => ({
				base: "main",
				head: "feature",
				status: "behind",
				aheadBy: 0,
				behindBy: 1,
				mergeBaseCommitSha: "merge-base",
			}),
			fetchIssueComments: async () => [
				{
					id: 1,
					body: "Looks good to me",
					htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/314#issuecomment-1",
					createdAt: "2026-05-26T00:00:00Z",
					updatedAt: "2026-05-26T00:00:00Z",
					authorLogin: "octocat",
				},
			],
			createIssueComment,
		});

		expect(result.classification).toBe("review_blocked");
		expect(createIssueComment).toHaveBeenCalledTimes(1);
		const graph = await listWorkItemGraph(client, workItemId);
		const blockedDecision = graph.decisions.find(
			(decision) =>
				decision.phase === "post_pr" && decision.outcome === "review_blocked",
		);
		expect(blockedDecision?.evidence).toEqual(
			expect.objectContaining({
				priorDecisionId: "dec_post_pr_monitor",
				baseSha: "base-new",
				headSha: "head-new",
				observedHumanActivity: expect.objectContaining({
					hasHumanActivity: true,
				}),
			}),
		);
		expect(graph.links.some((link) => link.relation === "evaluates")).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runHumanReviewMonitoring respects comment_on_conflict when review becomes blocked", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#315";
	const postPrWorkerRun = await createWorkerRun(client, {
		id: "wrn_post_pr_no_comment",
		workItemId,
		kind: "post_pr_curator",
		status: "completed",
	});
	await createDecision(client, {
		id: "dec_post_pr_no_comment",
		workItemId,
		workerRunId: postPrWorkerRun.id,
		phase: "post_pr",
		outcome: "human_review",
		now: 1,
		evidence: {
			pullRequestNumber: 315,
			baseSha: "base-old",
			headSha: "head-old",
			checkClassification: "checks_success",
		},
	});
	const existingDecisions = (await listWorkItemGraph(client, workItemId)).decisions;
	const createIssueComment = vi.fn();

	try {
		const result = await runHumanReviewMonitoring(client, {
			workItem: buildProjectItem(315),
			workItemId,
			owner: "toyamarinyon",
			repository: "rhapsody",
			pullRequestArtifact: {
				number: 315,
				url: "https://github.com/toyamarinyon/rhapsody/pull/315",
			},
			existingDecisions,
			postRunPolicy: {
				auto_merge_eligible: [],
				auto_merge_success_status: "Done",
				human_review_status: "Human Review",
				human_review_monitoring: {
					enabled: true,
					auto_integrate_base_before_human_activity: false,
					auto_integrate_base_after_human_activity: false,
					comment_on_conflict: false,
				},
			},
			getPullRequest: async () => ({
				reused: true,
				number: 315,
				htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/315",
				headRef: "feature",
				baseRef: "main",
				headSha: "head-old",
				baseSha: "base-new",
				title: "Review me",
			}),
			getPullRequestCheckSummary: async () => ({
				classification: "checks_success",
				headSha: "head-old",
				status: "success",
				checkRuns: [],
			}),
			comparePullRequestBranches: async () => ({
				base: "main",
				head: "feature",
				status: "behind",
				aheadBy: 0,
				behindBy: 1,
				mergeBaseCommitSha: "merge-base",
			}),
			fetchIssueComments: async () => [],
			createIssueComment,
		});

		expect(result.classification).toBe("review_blocked");
		expect(createIssueComment).not.toHaveBeenCalled();
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runHumanReviewMonitoring treats mergeability regressions as blocked stale review", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#316";
	const postPrWorkerRun = await createWorkerRun(client, {
		id: "wrn_post_pr_mergeability",
		workItemId,
		kind: "post_pr_curator",
		status: "completed",
	});
	await createDecision(client, {
		id: "dec_post_pr_mergeability",
		workItemId,
		workerRunId: postPrWorkerRun.id,
		phase: "post_pr",
		outcome: "human_review",
		now: 1,
		evidence: {
			pullRequestNumber: 316,
			baseSha: "base-stable",
			headSha: "head-stable",
			checkClassification: "checks_success",
			mergeability: {
				mergeable: true,
				mergeableState: "clean",
			},
		},
	});
	const existingDecisions = (await listWorkItemGraph(client, workItemId)).decisions;

	try {
		const result = await runHumanReviewMonitoring(client, {
			workItem: buildProjectItem(316),
			workItemId,
			owner: "toyamarinyon",
			repository: "rhapsody",
			pullRequestArtifact: {
				number: 316,
				url: "https://github.com/toyamarinyon/rhapsody/pull/316",
			},
			existingDecisions,
			postRunPolicy: {
				auto_merge_eligible: [],
				auto_merge_success_status: "Done",
				human_review_status: "Human Review",
				human_review_monitoring: {
					enabled: true,
					auto_integrate_base_before_human_activity: true,
					auto_integrate_base_after_human_activity: false,
					comment_on_conflict: true,
				},
			},
			getPullRequest: async () => ({
				reused: true,
				number: 316,
				htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/316",
				headRef: "feature",
				baseRef: "main",
				headSha: "head-stable",
				baseSha: "base-stable",
				title: "Review me",
				mergeable: false,
				mergeableState: "dirty",
			}),
			getPullRequestCheckSummary: async () => ({
				classification: "checks_success",
				headSha: "head-stable",
				status: "success",
				checkRuns: [],
			}),
			comparePullRequestBranches: async () => ({
				base: "main",
				head: "feature",
				status: "identical",
				aheadBy: 0,
				behindBy: 0,
				mergeBaseCommitSha: "merge-base",
			}),
			fetchIssueComments: async () => [],
			createIssueComment: vi.fn().mockResolvedValue({
				id: 11,
				htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/316#issuecomment-11",
			}),
		});

		expect(result.classification).toBe("review_blocked");
		const graph = await listWorkItemGraph(client, workItemId);
		const blockedDecision = graph.decisions.find(
			(decision) =>
				decision.phase === "post_pr" && decision.outcome === "review_blocked",
		);
		expect(blockedDecision?.evidence).toEqual(
			expect.objectContaining({
				reasonCode: "mergeability_conflict",
				staleSignals: expect.arrayContaining([
					"mergeability_changed",
					"mergeability_conflict",
				]),
			}),
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

function buildProjectItem(issueNumber: number) {
	return {
		issueNumber,
		issueTitle: `Post PR issue ${issueNumber}`,
		issueUrl: `https://github.com/toyamarinyon/rhapsody/issues/${issueNumber}`,
		issueBody: "A longer body is present to satisfy intake checks if needed.",
		issueState: "OPEN",
		projectStatus: "In Progress",
		blockedBy: [],
		projectFields: {},
		repository: {
			owner: "toyamarinyon",
			name: "rhapsody",
		},
	};
}

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
