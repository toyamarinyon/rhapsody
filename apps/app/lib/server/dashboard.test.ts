import { createClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";

import {
	createArtifact,
	createClaimedManualRun,
	createDecision,
	createEvent,
	createLink,
	createWorkerRun,
	getRunDetail,
	migrateStateStore,
	markAttemptStarted,
} from "@/lib/state";
import type { RhapsodyRunner } from "@/lib/config";
import {
	loadDashboardProjection,
	loadRunDiagnosticsProjection,
	loadWorkItemDiagnosticsProjection,
} from "@/lib/server/dashboard";

test("dashboard projection surfaces attention items and recent activity", async () => {
	const database = await createTestDatabase();

	try {
		const client = database.client;
		const workItemId = "github_issue:owner/repo#201";
		const created = await createClaimedManualRun(client, {
			workItemId,
			workItemTitle: "Fix dashboard diagnostics",
			workItemUrl: "https://github.com/owner/repo/issues/201",
			workItemStatus: "In Progress",
			workItemSnapshot: {
				issue: {
					number: 201,
					title: "Fix dashboard diagnostics",
					url: "https://github.com/owner/repo/issues/201",
					status: "In Progress",
				},
			},
			runner: "sandbox-codex",
			claimedBy: "scheduler",
			claimTtlMs: 60_000,
			now: 1_000,
		});
		if (!created.acquired) {
			throw new Error("expected claim to be acquired");
		}

		const detail = await getRunDetail(client, created.runId);
		if (!detail) {
			throw new Error("expected run detail");
		}
		await markAttemptStarted(client, {
			runId: detail.run.id,
			attemptId: detail.attempts[0]!.id,
			claimToken: detail.run.claimToken,
			sandboxId: "sandbox-1",
			command: "pnpm test",
			now: 1_100,
		});

		await createEvent(client, {
			runId: detail.run.id,
			attemptId: detail.attempts[0]!.id,
			level: "info",
			type: "sandbox.created",
			message: "Sandbox created.",
			data: {
				sandboxId: "sandbox-1",
				purpose: "builder_execution",
				workerKind: "builder",
				workItemId,
				runId: detail.run.id,
				attemptId: detail.attempts[0]!.id,
				timeoutMs: 120_000,
			},
			now: 1_200,
		});

		const projection = await loadDashboardProjection(client, 1_250);

		expect(projection.attentionItems).toHaveLength(1);
		expect(projection.attentionItems[0]?.attentionReason).toBe(
			"expiring claim",
		);
		expect(projection.recentActivity[0]?.runId).toBe(detail.run.id);
		expect(projection.stateSummary.recentEvents).toHaveLength(3);
	} finally {
		database.cleanup();
	}
});

test("work item diagnostics distinguishes GitHub from rhapsody evidence", async () => {
	const database = await createTestDatabase();

	try {
		const client = database.client;
		const workItemId = "github_issue:owner/repo#202";
		const runner: RhapsodyRunner = "sandbox-codex";
		const created = await createClaimedManualRun(client, {
			workItemId,
			workItemTitle: "Add diagnostics page",
			workItemUrl: "https://github.com/owner/repo/issues/202",
			workItemStatus: "Open",
			workItemSnapshot: {
				issue: {
					number: 202,
					title: "Add diagnostics page",
					url: "https://github.com/owner/repo/issues/202",
					status: "Open",
				},
			},
			runner,
			claimedBy: "scheduler",
			claimTtlMs: 60_000,
			now: 2_000,
		});

		await createWorkerRun(client, {
			id: "wrn_1",
			workItemId,
			kind: "builder",
			status: "running",
			claimToken: created.acquired ? created.claimToken : null,
			metadata: { purpose: "diagnostics" },
			workItemSnapshot: {
				issue: {
					number: 202,
					title: "Add diagnostics page",
					url: "https://github.com/owner/repo/issues/202",
					status: "Open",
				},
			},
			now: 2_050,
		});
		await createDecision(client, {
			id: "dec_1",
			workItemId,
			workerRunId: "wrn_1",
			phase: "intake",
			outcome: "buildable",
			evidence: { source: "tests" },
			now: 2_100,
		});
		await createArtifact(client, {
			id: "art_1",
			workItemId,
			workerRunId: "wrn_1",
			kind: "pull_request",
			externalUrl: "https://github.com/owner/repo/pull/50",
			now: 2_110,
		});
		await createLink(client, {
			id: "lnk_1",
			workItemId,
			fromNodeType: "worker_run",
			fromNodeId: "wrn_1",
			toNodeType: "decision",
			toNodeId: "dec_1",
			relation: "evaluates",
			now: 2_120,
		});
		await createEvent(client, {
			runId: created.acquired ? created.runId : null,
			attemptId: created.acquired ? created.attemptId : null,
			level: "info",
			type: "sandbox.created",
			message: "Sandbox created.",
			data: {
				sandboxId: "sandbox-2",
				workItemId,
				runId: created.acquired ? created.runId : null,
				attemptId: created.acquired ? created.attemptId : null,
				workerRunId: "wrn_1",
				timeoutMs: 120_000,
			},
			now: 2_130,
		});

		const projection = await loadWorkItemDiagnosticsProjection(
			client,
			workItemId,
		);

		expect(projection.github.title).toBe("Add diagnostics page");
		expect(projection.github.latestPrUrl).toBe(
			"https://github.com/owner/repo/pull/50",
		);
		expect(projection.rhapsody.latestRun?.status).toBe("pending");
		expect(projection.rhapsody.runs).toHaveLength(1);
		expect(projection.rhapsody.summary.workerRuns).toBe(1);
		expect(projection.graph.decisions).toHaveLength(1);
		expect(projection.graph.artifacts).toHaveLength(1);
		expect(projection.graph.links).toHaveLength(1);
		expect(projection.graph.sandboxSessions).toHaveLength(1);
	} finally {
		database.cleanup();
	}
});

test("run diagnostics summarises attempts, events, and evidence", async () => {
	const database = await createTestDatabase();

	try {
		const client = database.client;
		const workItemId = "github_issue:owner/repo#203";
		const created = await createClaimedManualRun(client, {
			workItemId,
			workItemTitle: "Stabilize dashboard",
			workItemUrl: "https://github.com/owner/repo/issues/203",
			workItemStatus: "Open",
			workItemSnapshot: {
				issue: {
					number: 203,
					title: "Stabilize dashboard",
					url: "https://github.com/owner/repo/issues/203",
					status: "Open",
				},
			},
			runner: "sandbox-codex",
			claimedBy: "scheduler",
			claimTtlMs: 60_000,
			now: 3_000,
		});
		if (!created.acquired) {
			throw new Error("expected claim to be acquired");
		}

		const projection = await loadRunDiagnosticsProjection(
			client,
			created.runId,
		);

		expect(projection?.workItem.title).toBe("Stabilize dashboard");
		expect(projection?.summary.failurePoint).toBeNull();
		expect(projection?.summary.attemptCount).toBe(1);
		expect(projection?.timeline.length).toBeGreaterThan(0);
		expect(projection?.summary.eventCount).toBeGreaterThan(0);
		expect(projection?.detail.claim).not.toBeNull();
	} finally {
		database.cleanup();
	}
});

async function createTestDatabase() {
	const dir = mkdtempSync(path.join(tmpdir(), "rhapsody-dashboard-test-"));
	const dbPath = path.join(dir, "state.db");
	const client = createClient({ url: `file:${dbPath}` });

	await migrateStateStore(client);

	return {
		client,
		cleanup() {
			client.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}
