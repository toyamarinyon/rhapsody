import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { expect, test, vi } from "vitest";
import {
	createDecision,
	createWorkerRun,
	listWorkItemGraph,
	migrateStateStore,
} from "@/lib/state";
import {
	runIntegrationRepairExecutor,
	runIntegrationRepairPlanner,
} from "./index";

test("runIntegrationRepairPlanner records a needed integration repair decision when the branch is behind", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#401";
	const postPrWorkerRun = await createWorkerRun(client, {
		id: "wrn_post_pr_401",
		workItemId,
		kind: "post_pr_curator",
		status: "completed",
	});
	const postPrDecisionId = await createDecision(client, {
		id: "dec_post_pr_401",
		workItemId,
		workerRunId: postPrWorkerRun.id,
		phase: "post_pr",
		outcome: "ci_failed",
		evidence: {
			pullRequestNumber: 401,
		},
	});

	try {
		const result = await runIntegrationRepairPlanner(client, {
			workItem: buildProjectItem(401),
			workItemId,
			postPrDecisionId,
			pullRequestNumber: 401,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/401",
			headSha: "head-401",
			baseSha: "base-401",
			branchComparison: {
				base: "main",
				head: "feature-401",
				status: "behind",
				aheadBy: 1,
				behindBy: 2,
				mergeBaseCommitSha: "merge-base-401",
			},
			existingDecisions: [],
		});

		expect(result.outcome).toBe("integration_repair_needed");
		expect(result.skippedFreshDuplicate).toBe(false);
		expect(result.integrationExecutionKey).toBe("401:head-401:base-401");

		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "integration_repair" &&
					decision.outcome === "integration_repair_needed",
			),
		).toBe(true);
		expect(
			graph.links.some(
				(link) =>
					link.fromNodeType === "decision" &&
					link.fromNodeId === postPrDecisionId &&
					link.toNodeType === "worker_run" &&
					link.relation === "starts",
			),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runIntegrationRepairPlanner records a current-branch decision when the branch is already current", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#402";
	const postPrWorkerRun = await createWorkerRun(client, {
		id: "wrn_post_pr_402",
		workItemId,
		kind: "post_pr_curator",
		status: "completed",
	});
	const postPrDecisionId = await createDecision(client, {
		id: "dec_post_pr_402",
		workItemId,
		workerRunId: postPrWorkerRun.id,
		phase: "post_pr",
		outcome: "checks_unknown",
		evidence: {
			pullRequestNumber: 402,
		},
	});

	try {
		const result = await runIntegrationRepairPlanner(client, {
			workItem: buildProjectItem(402),
			workItemId,
			postPrDecisionId,
			pullRequestNumber: 402,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/402",
			headSha: "head-402",
			baseSha: "base-402",
			branchComparison: {
				base: "main",
				head: "feature-402",
				status: "ahead",
				aheadBy: 1,
				behindBy: 0,
				mergeBaseCommitSha: "merge-base-402",
			},
			existingDecisions: [],
		});

		expect(result.outcome).toBe("integration_repair_current");
		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "integration_repair" &&
					decision.outcome === "integration_repair_current",
			),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runIntegrationRepairExecutor records integration_repair_applied and a commit artifact", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#403";
	const plan = await seedIntegrationPlan(client, workItemId, 403, "ci_failed");

	try {
		const result = await runIntegrationRepairExecutor({
			client,
			workItem: buildProjectItem(403),
			workItemId,
			pullRequestNumber: 403,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/403",
			owner: "toyamarinyon",
			repository: "rhapsody",
			headRef: "feature-403",
			baseRef: "main",
			plan,
			dependencies: buildExecutorDependencies({
				commandOutput: JSON.stringify({
					ok: true,
					outcome: "integration_repair_applied",
					artifact: {
						sha: "sha-applied-403",
						htmlUrl:
							"https://github.com/toyamarinyon/rhapsody/commit/sha-applied-403",
						changedFiles: ["package.json"],
					},
				}),
			}),
		});

		expect(result.outcome).toBe("integration_repair_applied");
		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "integration_repair" &&
					decision.outcome === "integration_repair_applied",
			),
		).toBe(true);
		expect(
			graph.artifacts.some(
				(artifact) =>
					artifact.kind === "commit" &&
					artifact.externalId === "sha-applied-403",
			),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runIntegrationRepairExecutor preserves integration_repair_conflict_unresolved for unresolved conflicts", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#404";
	const plan = await seedIntegrationPlan(client, workItemId, 404, "ci_failed");

	try {
		const result = await runIntegrationRepairExecutor({
			client,
			workItem: buildProjectItem(404),
			workItemId,
			pullRequestNumber: 404,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/404",
			owner: "toyamarinyon",
			repository: "rhapsody",
			headRef: "feature-404",
			baseRef: "main",
			plan,
			dependencies: buildExecutorDependencies({
				commandOutput: JSON.stringify({
					ok: false,
					outcome: "integration_repair_conflict_unresolved",
					error: "conflicts remained",
					conflictingFiles: ["lib/conflicted.ts"],
					remainingConflictingFiles: ["lib/conflicted.ts"],
				}),
			}),
		});

		expect(result.outcome).toBe("integration_repair_conflict_unresolved");
		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "integration_repair" &&
					decision.outcome === "integration_repair_conflict_unresolved",
			),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

async function seedIntegrationPlan(
	client: Client,
	workItemId: string,
	pullRequestNumber: number,
	postPrOutcome: "ci_failed" | "checks_unknown",
) {
	const postPrWorkerRun = await createWorkerRun(client, {
		id: `wrn_post_pr_${pullRequestNumber}`,
		workItemId,
		kind: "post_pr_curator",
		status: "completed",
	});
	const postPrDecisionId = await createDecision(client, {
		id: `dec_post_pr_${pullRequestNumber}`,
		workItemId,
		workerRunId: postPrWorkerRun.id,
		phase: "post_pr",
		outcome: postPrOutcome,
		evidence: {
			pullRequestNumber,
		},
	});

	return await runIntegrationRepairPlanner(client, {
		workItem: buildProjectItem(pullRequestNumber),
		workItemId,
		postPrDecisionId,
		pullRequestNumber,
		pullRequestUrl: `https://github.com/toyamarinyon/rhapsody/pull/${pullRequestNumber}`,
		headSha: `head-${pullRequestNumber}`,
		baseSha: `base-${pullRequestNumber}`,
		branchComparison: {
			base: "main",
			head: `feature-${pullRequestNumber}`,
			status: "behind",
			aheadBy: 1,
			behindBy: 1,
			mergeBaseCommitSha: `merge-base-${pullRequestNumber}`,
		},
		existingDecisions: [],
	});
}

function buildExecutorDependencies(input: { commandOutput: string }) {
	return {
		createVercelSandbox: vi.fn().mockResolvedValue({}),
		runVercelSandboxCommand: vi.fn().mockResolvedValue({
			commandId: "cmd_wrapper",
			cwd: "/vercel/sandbox",
			startedAt: 1,
			exitCode: 0,
			stdout: input.commandOutput,
			stderr: "",
		}),
		writeVercelSandboxFiles: vi.fn().mockResolvedValue(undefined),
		stopVercelSandbox: vi.fn().mockResolvedValue(undefined),
		loadMediatorCredentialState: vi
			.fn()
			.mockResolvedValue({ accountId: "acct_test" }),
		loadRhapsodyGitHubEnv: vi.fn().mockReturnValue({ GITHUB_TOKEN: "token" }),
		loadRhapsodyMediatorEnv: vi
			.fn()
			.mockReturnValue({ MEDIATOR_SECRET: "mediator-secret" }),
		loadRhapsodyProtectionBypassEnv: vi
			.fn()
			.mockReturnValue({ VERCEL_PROTECTION_BYPASS_SECRET: "bypass-secret" }),
		loadRunnerCodexConfig: vi
			.fn()
			.mockResolvedValue({
				config: null,
				loadedFromPath: ".rhapsody/config.toml",
			}),
	};
}

function buildProjectItem(issueNumber: number) {
	return {
		issueNumber,
		issueTitle: `Issue ${issueNumber}`,
		issueUrl: `https://github.com/toyamarinyon/rhapsody/issues/${issueNumber}`,
		issueState: "OPEN",
		issueBody: "body",
		projectStatus: "In Progress",
		repository: {
			owner: "toyamarinyon",
			name: "rhapsody",
		},
		blockedBy: [],
		projectFields: {},
	};
}

async function createTestDatabase() {
	const directory = mkdtempSync(
		path.join(tmpdir(), "rhapsody-integration-repair-"),
	);
	const client = createClient({
		url: `file:${path.join(directory, "state.db")}`,
	});
	await migrateStateStore(client);
	return {
		client,
		cleanup() {
			rmSync(directory, { recursive: true, force: true });
		},
	};
}
