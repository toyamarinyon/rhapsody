import { expect, test } from "vitest";
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
import type { PullRequestCheckSummary } from "@/lib/github/checks";
import {
	MAX_FORMAT_REPAIR_ATTEMPTS_PER_FAILURE_FINGERPRINT,
	MAX_FORMAT_REPAIR_ATTEMPTS_PER_HEAD_SHA,
	MAX_FORMAT_REPAIR_ATTEMPTS_PER_PULL_REQUEST,
	buildFailureFingerprint,
	classifyRepair,
	runRepairerPlanner,
} from "@/lib/workers/repairer";

test("classifyRepair detects format-only failed checks", () => {
	const summary: PullRequestCheckSummary = {
		classification: "ci_failed",
		status: "failure",
		headSha: "sha-1",
		checkRuns: [
			{
				name: "biome check",
				status: "completed",
				conclusion: "failure",
				detailsUrl: null,
			},
			{
				name: "tsc",
				status: "completed",
				conclusion: "success",
				detailsUrl: null,
			},
		],
	};

	const mixed = classifyRepair({
		...summary,
		checkRuns: [
			{
				name: "format check",
				status: "completed",
				conclusion: "failure",
				detailsUrl: null,
			},
			{
				name: "unit tests",
				status: "completed",
				conclusion: "failure",
				detailsUrl: null,
			},
		],
	});

	const none = classifyRepair({
		...summary,
		classification: "checks_success",
	});

	const formatOnly = classifyRepair({
		...summary,
		checkRuns: [
			{
				name: "prettier",
				status: "completed",
				conclusion: "failure",
				detailsUrl: null,
			},
		],
	});

	const checksUnknown = classifyRepair({
		...summary,
		checkRuns: [
			{
				name: "lint",
				status: "completed",
				conclusion: "timed_out",
				detailsUrl: null,
			},
		],
	});

	expect(none).toBe("not_deterministically_fixable");
	expect(mixed).toBe("not_deterministically_fixable");
	expect(formatOnly).toBe("format_fixable");
	expect(checksUnknown).toBe("not_deterministically_fixable");
	expect(summary.headSha).toBe("sha-1");
});

test("runRepairerPlanner allows repair for first format-only failure", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#413";

	try {
		const postPrRun = await createWorkerRun(client, {
			id: "wrn_post_pr_for_repair_allowed",
			workItemId,
			kind: "post_pr_curator",
			status: "completed",
		});

		const postPrDecision = await createDecision(client, {
			id: "dec_post_pr_repair_allowed",
			workItemId,
			workerRunId: postPrRun.id,
			phase: "post_pr",
			outcome: "ci_failed",
		});

		const result = await runRepairerPlanner(client, {
			workItem: buildProjectItem(413),
			workItemId,
			postPrDecisionId: postPrDecision,
			pullRequestNumber: 413,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/413",
			checkSummary: {
				classification: "ci_failed",
				headSha: "sha-413",
				status: "failure",
				checkRuns: [
					{
						name: "format check",
						status: "completed",
						conclusion: "failure",
						detailsUrl: null,
					},
				],
			},
			existingDecisions: [],
		});

		expect(result.outcome).toBe("repair_allowed");
		expect(result.classification).toBe("format_fixable");
		expect(result.attemptCount).toBe(0);
		expect(result.workerRunId).toBeTypeOf("string");
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerPlanner blocks repair after max attempts and emits decision metadata", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#412";

	try {
		const postPrRun = await createWorkerRun(client, {
			id: "wrn_post_pr_for_repair",
			workItemId,
			kind: "post_pr_curator",
			status: "completed",
		});

		const postPrDecision = await createDecision(client, {
			id: "dec_post_pr_repair",
			workItemId,
			workerRunId: postPrRun.id,
			phase: "post_pr",
			outcome: "ci_failed",
		});

		await createWorkerRun(client, {
			id: "wrn_existing_repair_1",
			workItemId,
			kind: "repairer",
			status: "completed",
		});
		await createDecision(client, {
			id: "dec_repair_1",
			workItemId,
			workerRunId: "wrn_existing_repair_1",
			phase: "repair",
			outcome: "repair_allowed",
			policyRuleId: "format_fixable",
			evidence: {
				pullRequestNumber: 412,
				classification: "format_fixable",
				checks: {
					headSha: "sha-412",
				},
			},
		});

		await createWorkerRun(client, {
			id: "wrn_existing_repair_2",
			workItemId,
			kind: "repairer",
			status: "completed",
		});
		await createDecision(client, {
			id: "dec_repair_2",
			workItemId,
			workerRunId: "wrn_existing_repair_2",
			phase: "repair",
			outcome: "repair_allowed",
			policyRuleId: "format_fixable",
			evidence: {
				pullRequestNumber: 412,
				classification: "format_fixable",
				checks: {
					headSha: "sha-412",
				},
			},
		});

		const result = await runRepairerPlanner(client, {
			workItem: buildProjectItem(412),
			workItemId,
			postPrDecisionId: postPrDecision,
			pullRequestNumber: 412,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/412",
			checkSummary: {
				classification: "ci_failed",
				headSha: "sha-412",
				status: "failure",
				checkRuns: [
					{
						name: "biome",
						status: "completed",
						conclusion: "failure",
						detailsUrl: null,
					},
				],
			},
			existingDecisions: [
				{
					id: "dec_repair_1",
					workItemId,
					workerRunId: "wrn_existing_repair_1",
					phase: "repair",
					outcome: "repair_allowed",
					deterministic: true,
					policyVersion: null,
					policyRuleId: "format_fixable",
					evidence: {
						pullRequestNumber: 412,
						classification: "format_fixable",
						checks: { headSha: "sha-412" },
					},
					nextWorkerKind: null,
					nextAction: null,
					createdAt: 1,
					updatedAt: 1,
				},
				{
					id: "dec_repair_2",
					workItemId,
					workerRunId: "wrn_existing_repair_2",
					phase: "repair",
					outcome: "repair_allowed",
					deterministic: true,
					policyVersion: null,
					policyRuleId: "format_fixable",
					evidence: {
						pullRequestNumber: 412,
						classification: "format_fixable",
						checks: { headSha: "sha-412" },
					},
					nextWorkerKind: null,
					nextAction: null,
					createdAt: 2,
					updatedAt: 2,
				},
			],
		});

		expect(result.outcome).toBe("repair_blocked");
		expect(result.classification).toBe("format_fixable");
		expect(result.attemptCount).toBe(2);

		const graph = await listWorkItemGraph(client, workItemId);
		expect(graph.workerRuns.some((run) => run.kind === "repairer")).toBe(true);
		expect(graph.decisions).toHaveLength(4);
		const latestDecision = graph.decisions.find(
			(decision) => decision.id === result.decisionId,
		);
		expect(latestDecision?.policyRuleId).toBe("format_fixable");
		expect(latestDecision?.nextWorkerKind).toBeNull();
		expect(latestDecision?.nextAction).toBe(
			"Escalate because the failure is not safely repairable or repair budget is exhausted.",
		);
		const startLink = graph.links.find(
			(link) =>
				link.fromNodeId === postPrDecision && link.relation === "starts",
		);
		expect(startLink).toEqual(
			expect.objectContaining({
				relation: "starts",
				metadata: expect.objectContaining({ reason: "format_fixable" }),
			}),
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerPlanner blocks non-format failures as not repairable", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#414";

	try {
		const postPrRun = await createWorkerRun(client, {
			id: "wrn_post_pr_for_repair_blocked",
			workItemId,
			kind: "post_pr_curator",
			status: "completed",
		});

		const postPrDecision = await createDecision(client, {
			id: "dec_post_pr_repair_blocked",
			workItemId,
			workerRunId: postPrRun.id,
			phase: "post_pr",
			outcome: "ci_failed",
		});

		const result = await runRepairerPlanner(client, {
			workItem: buildProjectItem(414),
			workItemId,
			postPrDecisionId: postPrDecision,
			pullRequestNumber: 414,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/414",
			checkSummary: {
				classification: "ci_failed",
				headSha: "sha-414",
				status: "failure",
				checkRuns: [
					{
						name: "unit tests",
						status: "completed",
						conclusion: "failure",
						detailsUrl: null,
					},
				],
			},
			existingDecisions: [],
		});

		expect(result.outcome).toBe("repair_blocked");
		expect(result.classification).toBe("not_deterministically_fixable");
		expect(result.attemptCount).toBe(0);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerPlanner counts format repair attempts per PR and head SHA", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#415";

	try {
		const postPrRun = await createWorkerRun(client, {
			id: "wrn_post_pr_for_repair_attempts",
			workItemId,
			kind: "post_pr_curator",
			status: "completed",
		});

		const postPrDecision = await createDecision(client, {
			id: "dec_post_pr_repair_attempts",
			workItemId,
			workerRunId: postPrRun.id,
			phase: "post_pr",
			outcome: "ci_failed",
		});

		await createWorkerRun(client, {
			id: "wrn_repair_seed",
			workItemId,
			kind: "repairer",
			status: "completed",
		});
		await createDecision(client, {
			id: "dec_repair_seed",
			workItemId,
			workerRunId: "wrn_repair_seed",
			phase: "repair",
			outcome: "repair_allowed",
			policyRuleId: "format_fixable",
			evidence: {
				pullRequestNumber: 415,
				classification: "format_fixable",
				checks: {
					headSha: "sha-415-old",
				},
			},
		});

		await createWorkerRun(client, {
			id: "wrn_repair_seed_new",
			workItemId,
			kind: "repairer",
			status: "completed",
		});
		await createDecision(client, {
			id: "dec_repair_seed_new",
			workItemId,
			workerRunId: "wrn_repair_seed_new",
			phase: "repair",
			outcome: "repair_allowed",
			policyRuleId: "format_fixable",
			evidence: {
				pullRequestNumber: 415,
				classification: "format_fixable",
				checks: {
					headSha: "sha-415-new",
				},
			},
		});

		const result = await runRepairerPlanner(client, {
			workItem: buildProjectItem(415),
			workItemId,
			postPrDecisionId: postPrDecision,
			pullRequestNumber: 415,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/415",
			checkSummary: {
				classification: "ci_failed",
				headSha: "sha-415-newest",
				status: "failure",
				checkRuns: [
					{
						name: "prettier",
						status: "completed",
						conclusion: "failure",
						detailsUrl: null,
					},
				],
			},
			existingDecisions: [
				{
					id: "dec_repair_seed",
					workItemId,
					workerRunId: "wrn_repair_seed",
					phase: "repair",
					outcome: "repair_allowed",
					deterministic: true,
					policyVersion: null,
					policyRuleId: "format_fixable",
					evidence: {
						pullRequestNumber: 415,
						classification: "format_fixable",
						checks: { headSha: "sha-415-old" },
					},
					nextWorkerKind: null,
					nextAction: null,
					createdAt: 1,
					updatedAt: 1,
				},
				{
					id: "dec_repair_seed_new",
					workItemId,
					workerRunId: "wrn_repair_seed_new",
					phase: "repair",
					outcome: "repair_allowed",
					deterministic: true,
					policyVersion: null,
					policyRuleId: "format_fixable",
					evidence: {
						pullRequestNumber: 415,
						classification: "format_fixable",
						checks: { headSha: "sha-415-new" },
					},
					nextWorkerKind: null,
					nextAction: null,
					createdAt: 2,
					updatedAt: 2,
				},
			],
		});

		expect(result.outcome).toBe("repair_allowed");
		expect(result.attemptCount).toBe(0);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerPlanner enforces PR-wide repair budget", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#416";

	try {
		const postPrRun = await createWorkerRun(client, {
			id: "wrn_post_pr_for_repair_budget_pr",
			workItemId,
			kind: "post_pr_curator",
			status: "completed",
		});

		const postPrDecision = await createDecision(client, {
			id: "dec_post_pr_repair_budget_pr",
			workItemId,
			workerRunId: postPrRun.id,
			phase: "post_pr",
			outcome: "ci_failed",
		});

		for (
			let index = 0;
			index < MAX_FORMAT_REPAIR_ATTEMPTS_PER_PULL_REQUEST;
			index += 1
		) {
			await createWorkerRun(client, {
				id: `wrn_repair_budget_${index}`,
				workItemId,
				kind: "repairer",
				status: "completed",
			});
			await createDecision(client, {
				id: `dec_repair_budget_${index}`,
				workItemId,
				workerRunId: `wrn_repair_budget_${index}`,
				phase: "repair",
				outcome: "repair_failed",
				policyRuleId: "format_fixable",
				evidence: {
					pullRequestNumber: 416,
					classification: "format_fixable",
					checks: {
						headSha: `sha-${index}`,
					},
					failureFingerprint: "shared-fingerprint",
				},
			});
		}

		const result = await runRepairerPlanner(client, {
			workItem: buildProjectItem(416),
			workItemId,
			postPrDecisionId: postPrDecision,
			pullRequestNumber: 416,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/416",
			checkSummary: {
				classification: "ci_failed",
				headSha: "sha-new",
				status: "failure",
				checkRuns: [
					{
						name: "prettier",
						status: "completed",
						conclusion: "failure",
						detailsUrl: null,
					},
				],
			},
			existingDecisions: (await listWorkItemGraph(client, workItemId))
				.decisions,
		});

		expect(result.outcome).toBe("repair_blocked");
		expect(result.attemptCounts.pullRequest).toBe(
			MAX_FORMAT_REPAIR_ATTEMPTS_PER_PULL_REQUEST,
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerPlanner enforces failure fingerprint budget", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#417";

	try {
		const postPrRun = await createWorkerRun(client, {
			id: "wrn_post_pr_for_repair_budget_fp",
			workItemId,
			kind: "post_pr_curator",
			status: "completed",
		});

		const postPrDecision = await createDecision(client, {
			id: "dec_post_pr_repair_budget_fp",
			workItemId,
			workerRunId: postPrRun.id,
			phase: "post_pr",
			outcome: "ci_failed",
		});

		const sharedFingerprint = buildFailureFingerprint({
			checkRuns: [
				{
					name: "prettier",
					status: "completed",
					conclusion: "failure",
					detailsUrl: null,
				},
			],
		});

		for (
			let index = 0;
			index < MAX_FORMAT_REPAIR_ATTEMPTS_PER_FAILURE_FINGERPRINT;
			index += 1
		) {
			await createWorkerRun(client, {
				id: `wrn_repair_fp_${index}`,
				workItemId,
				kind: "repairer",
				status: "completed",
			});
			await createDecision(client, {
				id: `dec_repair_fp_${index}`,
				workItemId,
				workerRunId: `wrn_repair_fp_${index}`,
				phase: "repair",
				outcome: "repair_failed",
				policyRuleId: "format_fixable",
				evidence: {
					pullRequestNumber: 417,
					classification: "format_fixable",
					checks: {
						headSha: `sha-fp-${index}`,
					},
					failureFingerprint: sharedFingerprint,
				},
			});
		}

		const result = await runRepairerPlanner(client, {
			workItem: buildProjectItem(417),
			workItemId,
			postPrDecisionId: postPrDecision,
			pullRequestNumber: 417,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/417",
			checkSummary: {
				classification: "ci_failed",
				headSha: "sha-417-new",
				status: "failure",
				checkRuns: [
					{
						name: "prettier",
						status: "completed",
						conclusion: "failure",
						detailsUrl: null,
					},
				],
			},
			existingDecisions: (await listWorkItemGraph(client, workItemId))
				.decisions,
		});

		expect(result.outcome).toBe("repair_blocked");
		expect(result.attemptCounts.fingerprint).toBe(
			MAX_FORMAT_REPAIR_ATTEMPTS_PER_FAILURE_FINGERPRINT,
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerPlanner records failureFingerprint and repairExecutionKey", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#418";

	try {
		const postPrRun = await createWorkerRun(client, {
			id: "wrn_post_pr_for_repair_meta",
			workItemId,
			kind: "post_pr_curator",
			status: "completed",
		});

		const postPrDecision = await createDecision(client, {
			id: "dec_post_pr_repair_meta",
			workItemId,
			workerRunId: postPrRun.id,
			phase: "post_pr",
			outcome: "ci_failed",
		});

		const checkSummary = {
			classification: "ci_failed" as const,
			headSha: "sha-418",
			status: "failure" as const,
			checkRuns: [
				{
					name: "prettier",
					status: "completed",
					conclusion: "failure",
					detailsUrl: null,
				},
			],
		};
		const fingerprint = buildFailureFingerprint(checkSummary);

		const result = await runRepairerPlanner(client, {
			workItem: buildProjectItem(418),
			workItemId,
			postPrDecisionId: postPrDecision,
			pullRequestNumber: 418,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/418",
			checkSummary,
			existingDecisions: [],
		});

		expect(result.repairExecutionKey).toBe("418:sha-418:" + fingerprint);
		expect(result.failureFingerprint).toBe(fingerprint);

		const graph = await listWorkItemGraph(client, workItemId);
		const repairDecision = graph.decisions.find(
			(decision) => decision.id === result.decisionId,
		);
		expect(repairDecision?.evidence).toEqual(
			expect.objectContaining({
				repairExecutionKey: result.repairExecutionKey,
				failureFingerprint: fingerprint,
				attemptCounts: {
					headSha: 0,
					pullRequest: 0,
					fingerprint: 0,
				},
				maxAttempts: {
					headSha: MAX_FORMAT_REPAIR_ATTEMPTS_PER_HEAD_SHA,
					pullRequest: MAX_FORMAT_REPAIR_ATTEMPTS_PER_PULL_REQUEST,
					fingerprint: MAX_FORMAT_REPAIR_ATTEMPTS_PER_FAILURE_FINGERPRINT,
				},
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
		issueTitle: `Repair issue ${issueNumber}`,
		issueUrl: `https://github.com/toyamarinyon/rhapsody/issues/${issueNumber}`,
		issueState: "OPEN",
		issueBody: "A body for the repairer planner checks.",
		projectStatus: "In Progress",
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
