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
import {
	runPostPrCurator,
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
