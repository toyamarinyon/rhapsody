import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";

import {
	createArtifact,
	createDecision,
	createLink,
	createWorkerRun,
	listWorkItemGraph,
	migrateStateStore,
	updateWorkerRunStatus,
} from "@/lib/state";

test("worker graph CRUD stores and parses metadata JSON consistently", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:owner/repo#101";

	try {
		const olderRun = await createWorkerRun(client, {
			id: "wrn_old",
			workItemId,
			kind: "builder",
			status: "pending",
			metadata: { queue: "old" },
			workItemSnapshot: { kind: "snapshot", index: 1 },
			now: 10,
		});

		const newerRun = await createWorkerRun(client, {
			id: "wrn_new",
			workItemId,
			kind: "intake_curator",
			status: "completed",
			metadata: { queue: "new" },
			now: 20,
		});

		const decisionId = await createDecision(client, {
			id: "dec_meta",
			workItemId,
			workerRunId: newerRun.id,
			phase: "intake",
			outcome: "buildable",
			evidence: {
				issueTitle: "Test issue",
				nested: { labels: ["a", "b"] },
			},
			now: 30,
		});

		const artifactId = await createArtifact(client, {
			id: "art_meta",
			workItemId,
			workerRunId: newerRun.id,
			kind: "pull_request",
			externalId: "12",
			externalUrl: "https://example.org/pr/12",
			metadata: {
				source: "tests",
			},
			now: 40,
		});

		const linkId = await createLink(client, {
			id: "lnk_meta",
			workItemId,
			fromNodeType: "worker_run",
			fromNodeId: newerRun.id,
			toNodeType: "decision",
			toNodeId: decisionId,
			relation: "evaluates",
			metadata: {
				checkClassification: "checks_success",
			},
			now: 50,
		});

		const graph = await listWorkItemGraph(client, workItemId);

		expect(graph.workItemId).toBe(workItemId);
		expect(graph.workerRuns.map((run) => run.id)).toEqual([
			newerRun.id,
			olderRun.id,
		]);
		expect(graph.decisions).toHaveLength(1);
		expect(graph.decisions[0]?.evidence).toEqual({
			issueTitle: "Test issue",
			nested: { labels: ["a", "b"] },
		});
		expect(graph.artifacts[0]).toEqual(
			expect.objectContaining({
				snapshot: null,
				metadata: { source: "tests" },
				externalId: "12",
				externalUrl: "https://example.org/pr/12",
				id: artifactId,
			}),
		);
		expect(graph.links.map((link) => link.id)).toEqual([linkId]);
		expect(graph.links[0]).toEqual(
			expect.objectContaining({
				fromNodeId: newerRun.id,
				toNodeId: decisionId,
				relation: "evaluates",
				metadata: { checkClassification: "checks_success" },
			}),
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("worker run timestamps move to running and completed states correctly", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:owner/repo#102";

	try {
		await createWorkerRun(client, {
			id: "wrn_timing",
			workItemId,
			kind: "builder",
			status: "pending",
			now: 100,
		});

		await updateWorkerRunStatus(client, {
			id: "wrn_timing",
			status: "running",
			now: 200,
		});

		await updateWorkerRunStatus(client, {
			id: "wrn_timing",
			status: "completed",
			now: 300,
		});

		const graph = await listWorkItemGraph(client, workItemId);
		expect(graph.workerRuns).toHaveLength(1);
		expect(graph.workerRuns[0]?.status).toBe("completed");
		expect(graph.workerRuns[0]?.startedAt).toBe(200);
		expect(graph.workerRuns[0]?.finishedAt).toBe(300);
		expect(graph.workerRuns[0]?.updatedAt).toBe(300);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("listWorkItemGraph returns only rows for requested work item", async () => {
	const database = await createTestDatabase();
	const client = database.client;

	try {
		const matchingWorkItem = "github_issue:owner/repo#103";
		const otherWorkItem = "github_issue:owner/repo#104";

		const matchingRun = await createWorkerRun(client, {
			id: "wrn_match",
			workItemId: matchingWorkItem,
			kind: "intake_curator",
			status: "pending",
		});
		const otherRun = await createWorkerRun(client, {
			id: "wrn_other",
			workItemId: otherWorkItem,
			kind: "builder",
			status: "pending",
		});

		const matchingDecision = await createDecision(client, {
			id: "dec_match",
			workItemId: matchingWorkItem,
			workerRunId: matchingRun.id,
			phase: "intake",
			outcome: "buildable",
		});
		await createDecision(client, {
			id: "dec_other",
			workItemId: otherWorkItem,
			workerRunId: otherRun.id,
			phase: "post_pr",
			outcome: "ci_failed",
		});

		await createArtifact(client, {
			id: "art_match",
			workItemId: matchingWorkItem,
			workerRunId: matchingRun.id,
			kind: "pull_request",
			externalId: "10",
			externalUrl: "https://example.org/match",
			snapshot: { match: true },
			metadata: { source: "tests" },
		});
		await createArtifact(client, {
			id: "art_other",
			workItemId: otherWorkItem,
			workerRunId: otherRun.id,
			kind: "pull_request",
			externalId: "11",
			externalUrl: "https://example.org/other",
			snapshot: { match: false },
			metadata: { source: "tests" },
		});

		const graph = await listWorkItemGraph(client, matchingWorkItem);

		expect(graph.workerRuns).toHaveLength(1);
		expect(graph.workerRuns[0]?.id).toBe("wrn_match");
		expect(graph.decisions).toHaveLength(1);
		expect(graph.decisions[0]?.id).toBe(matchingDecision);
		expect(graph.artifacts).toHaveLength(1);
		expect(graph.artifacts[0]?.id).toBe("art_match");
		expect(graph.links).toHaveLength(0);
		expect(graph.sandboxSessions).toEqual([]);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("listWorkItemGraph preserves link order and parses artifact snapshots", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:owner/repo#105";

	try {
		const intakeRun = await createWorkerRun(client, {
			id: "wrn_order_a",
			workItemId,
			kind: "intake_curator",
			status: "pending",
			now: 20,
		});
		const builderRun = await createWorkerRun(client, {
			id: "wrn_order_b",
			workItemId,
			kind: "builder",
			status: "pending",
			now: 10,
		});

		const firstLink = await createLink(client, {
			id: "lnk_a",
			workItemId,
			fromNodeType: "decision",
			fromNodeId: intakeRun.id,
			toNodeType: "worker_run",
			toNodeId: builderRun.id,
			relation: "starts",
			now: 40,
		});
		const secondLink = await createLink(client, {
			id: "lnk_b",
			workItemId,
			fromNodeType: "worker_run",
			fromNodeId: builderRun.id,
			toNodeType: "decision",
			toNodeId: "dec-ignored",
			relation: "evaluates",
			now: 30,
			metadata: { order: 2 },
		});
		const thirdLink = await createLink(client, {
			id: "lnk_c",
			workItemId,
			fromNodeType: "worker_run",
			fromNodeId: builderRun.id,
			toNodeType: "decision",
			toNodeId: "dec-ignored",
			relation: "decides",
			now: 50,
			metadata: { order: 1 },
		});

		await createArtifact(client, {
			id: "art_null_snapshot",
			workItemId,
			kind: "pull_request",
			externalId: "55",
			externalUrl: "https://example.org/pr/55",
		});
		await createArtifact(client, {
			id: "art_object_snapshot",
			workItemId,
			kind: "summary",
			externalId: null,
			externalUrl: null,
			snapshot: { score: 10 },
			metadata: {},
		});

		const graph = await listWorkItemGraph(client, workItemId);

		expect(graph.links.map((link) => link.id)).toEqual([
			secondLink,
			firstLink,
			thirdLink,
		]);
		expect(
			graph.artifacts.find((artifact) => artifact.id === "art_null_snapshot")
				?.snapshot,
		).toBe(null);
		expect(
			graph.artifacts.find((artifact) => artifact.id === "art_object_snapshot")
				?.snapshot,
		).toEqual({ score: 10 });
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
