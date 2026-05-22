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
import { classifyRepair, runRepairerPlanner } from "@/lib/workers/repairer";

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
				metadata: { reason: "format_fixable" },
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
