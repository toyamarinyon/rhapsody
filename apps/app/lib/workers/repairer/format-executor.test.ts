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
import * as runnerCodexConfig from "@/lib/runner-codex-config";
import { runRepairerExecutor } from "@/lib/workers/repairer/format-executor";
import {
	buildRepairExecutionKey,
	buildFailureFingerprint,
} from "@/lib/workers/repairer";
import type { PullRequestSummary } from "@/lib/github/pull-requests";
import type { PullRequestCheckSummary } from "@/lib/github/checks";

const failedFormatCheckRuns: PullRequestCheckSummary["checkRuns"] = [
	{
		name: "prettier",
		status: "completed",
		conclusion: "failure",
		detailsUrl: null,
	},
];

const baseMetadata = {
	pullRequestNumber: 300,
	headSha: "sha-300",
	repairExecutionKey: buildRepairExecutionKey({
		pullRequestNumber: 300,
		headSha: "sha-300",
		failureFingerprint: buildFailureFingerprint({
			checkRuns: failedFormatCheckRuns,
		}),
	}),
	detailFailureFingerprint: buildFailureFingerprint({
		checkRuns: failedFormatCheckRuns,
	}),
};

function buildPlan() {
	return {
		decisionId: "repair_planner_decision",
		repairExecutionKey: baseMetadata.repairExecutionKey,
		failureFingerprint: baseMetadata.detailFailureFingerprint,
		attemptCounts: { headSha: 0, pullRequest: 0, fingerprint: 0 },
		maxAttempts: { headSha: 2, pullRequest: 6, fingerprint: 2 },
	};
}

function buildCheckSummary() {
	return {
		classification: "ci_failed" as const,
		headSha: baseMetadata.headSha,
		status: "failure" as const,
		checkRuns: [
			{
				name: "prettier",
				status: "completed" as const,
				conclusion: "failure" as const,
				detailsUrl: "https://example.com/check",
			},
		],
	};
}

function workItem() {
	return {
		issueNumber: baseMetadata.pullRequestNumber,
		issueTitle: "Executor test issue",
		issueUrl: "https://github.com/toyamarinyon/rhapsody/issues/300",
		issueState: "OPEN" as const,
		issueBody: "Executor test issue body",
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

function sandboxCommand(summary: string) {
	return {
		commandId: "cmd-1",
		cwd: "/vercel/sandbox",
		startedAt: Date.now(),
		exitCode: 0,
		stdout: summary,
		stderr: "",
	};
}

function mockDependencies(args: {
	commandOutput: string;
	writeMetadataCapture?: (metadata: unknown) => void;
	getPullRequestChangedFiles?: () => Promise<string[]>;
}) {
	return {
		getPullRequest: vi.fn().mockResolvedValue({
			reused: true,
			number: baseMetadata.pullRequestNumber,
			htmlUrl: "https://github.com/toyamarinyon/rhapsody/pull/300",
			headRef: "rhapsody/issue-300",
			baseRef: "main",
			title: "Issue 300",
		} as PullRequestSummary),
		getPullRequestChangedFiles: vi.fn().mockImplementation(async () => {
			if (args.getPullRequestChangedFiles) {
				return args.getPullRequestChangedFiles();
			}
			return ["src/index.ts"];
		}),
		createVercelSandbox: vi.fn().mockResolvedValue({ sandboxId: "sandbox-1" }),
		runVercelSandboxCommand: vi
			.fn()
			.mockResolvedValue(sandboxCommand(args.commandOutput)),
		writeVercelSandboxFiles: vi
			.fn()
			.mockImplementation(
				async (
					_: unknown,
					files: Array<{ path: string; content: unknown }>,
				) => {
					if (args.writeMetadataCapture) {
						const metadataFile = files.find(
							(file) => file.path === "metadata.json",
						);
						if (metadataFile && typeof metadataFile.content === "string") {
							args.writeMetadataCapture(JSON.parse(metadataFile.content));
						}
					}
				},
			),
		stopVercelSandbox: vi.fn().mockResolvedValue(undefined),
	} as const;
}

async function createAllowedRepairPlanDecision(
	client: Client,
	workItemId: string,
	decisionId: string,
	allowedChangedFiles: string[] = [],
) {
	await createWorkerRun(client, {
		id: "repair_planner_run",
		workItemId,
		kind: "repairer",
		status: "completed",
	});
	await createDecision(client, {
		id: decisionId,
		workItemId,
		workerRunId: "repair_planner_run",
		phase: "repair",
		outcome: "repair_allowed",
		policyRuleId: "format_fixable",
		evidence: {
			pullRequestNumber: baseMetadata.pullRequestNumber,
			classification: "format_fixable",
			repairExecutionKey: baseMetadata.repairExecutionKey,
			failureFingerprint: baseMetadata.detailFailureFingerprint,
			allowedChangedFiles,
			checkSummary: buildCheckSummary(),
			checks: { headSha: baseMetadata.headSha },
		},
	});
}

test("runRepairerExecutor records repair_applied decision and commit artifact", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#300";

	try {
		await createAllowedRepairPlanDecision(
			client,
			workItemId,
			buildPlan().decisionId,
			["src/index.ts"],
		);

		const deps = mockDependencies({
			commandOutput: JSON.stringify({
				ok: true,
				outcome: "repair_applied",
				artifact: {
					sha: "new-sha",
					htmlUrl: "https://github.com/toyamarinyon/rhapsody/commit/new-sha",
					changedFiles: ["src/index.ts"],
				},
			}),
		});

		const result = await runRepairerExecutor({
			client,
			workItem: workItem(),
			workItemId,
			pullRequestNumber: baseMetadata.pullRequestNumber,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/300",
			checkSummary: buildCheckSummary(),
			repositoryBaseBranch: "main",
			plan: buildPlan(),
			owner: "toyamarinyon",
			repository: "rhapsody",
			dependencies: deps,
		});

		expect(result.executed).toBe(true);
		expect(result.outcome).toBe("repair_applied");
		expect(result.decisionId).toBeDefined();

		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "repair" && decision.outcome === "repair_applied",
			),
		).toBe(true);
		expect(graph.artifacts.some((artifact) => artifact.kind === "commit")).toBe(
			true,
		);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerExecutor records repair_noop decision", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#300";

	try {
		await createAllowedRepairPlanDecision(
			client,
			workItemId,
			"repair_planner_decision",
			["src/index.ts"],
		);

		const deps = mockDependencies({
			commandOutput: JSON.stringify({
				ok: true,
				outcome: "repair_noop",
			}),
		});

		const result = await runRepairerExecutor({
			client,
			workItem: workItem(),
			workItemId,
			pullRequestNumber: baseMetadata.pullRequestNumber,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/301",
			checkSummary: buildCheckSummary(),
			repositoryBaseBranch: "main",
			plan: { ...buildPlan(), decisionId: "repair_planner_decision" },
			owner: "toyamarinyon",
			repository: "rhapsody",
			dependencies: deps,
		});

		expect(result.executed).toBe(true);
		expect(result.outcome).toBe("repair_noop");

		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "repair" && decision.outcome === "repair_noop",
			),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerExecutor applies merged GitHub and dependency network policies", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#300";
	const originalToken = process.env.GITHUB_TOKEN;

	const loadRunnerCodexConfigSpy = vi
		.spyOn(runnerCodexConfig, "loadRunnerCodexConfig")
		.mockResolvedValue({
			loadedFromPath: "/tmp/.rhapsody/config.toml",
			config: {
				model: "gpt-5.2",
				sandbox: {
					networkPolicy: {
						preset: "common_dependencies",
						domains: {
							"registry.npmjs.org": "allow",
						},
					},
				},
			},
		});

	process.env.GITHUB_TOKEN = "test-token";

	try {
		await createAllowedRepairPlanDecision(
			client,
			workItemId,
			buildPlan().decisionId,
			["src/index.ts"],
		);

		const deps = mockDependencies({
			commandOutput: JSON.stringify({
				ok: true,
				outcome: "repair_noop",
			}),
		});

		const result = await runRepairerExecutor({
			client,
			workItem: workItem(),
			workItemId,
			pullRequestNumber: baseMetadata.pullRequestNumber,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/300",
			checkSummary: buildCheckSummary(),
			repositoryBaseBranch: "main",
			plan: buildPlan(),
			owner: "toyamarinyon",
			repository: "rhapsody",
			dependencies: deps,
		});

		const networkPolicy =
			deps.createVercelSandbox.mock.calls[0]?.[0]?.networkPolicy;
		const allowList = networkPolicy?.allow as Record<string, unknown>;

		expect(result.executed).toBe(true);
		expect(result.outcome).toBe("repair_noop");
		expect(allowList).toHaveProperty("github.com");
		expect(allowList).toHaveProperty("npmjs.org");
		expect(allowList).toHaveProperty("*.npmjs.org");
	} finally {
		if (originalToken === undefined) {
			delete process.env.GITHUB_TOKEN;
		} else {
			process.env.GITHUB_TOKEN = originalToken;
		}
		loadRunnerCodexConfigSpy.mockRestore();
		client.close();
		database.cleanup();
	}
});

test("runRepairerExecutor records repair_failed and supports retries", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#300";

	try {
		await createAllowedRepairPlanDecision(
			client,
			workItemId,
			"repair_planner_decision",
			["src/index.ts"],
		);

		const deps = mockDependencies({
			commandOutput: "not json",
		});

		const result = await runRepairerExecutor({
			client,
			workItem: workItem(),
			workItemId,
			pullRequestNumber: baseMetadata.pullRequestNumber,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/302",
			checkSummary: buildCheckSummary(),
			repositoryBaseBranch: "main",
			plan: { ...buildPlan(), decisionId: "repair_planner_decision" },
			owner: "toyamarinyon",
			repository: "rhapsody",
			dependencies: deps,
		});

		expect(result.executed).toBe(true);
		expect(result.outcome).toBe("repair_failed");
		const graph = await listWorkItemGraph(client, workItemId);
		expect(
			graph.decisions.some(
				(decision) =>
					decision.phase === "repair" && decision.outcome === "repair_failed",
			),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerExecutor records repair_failed when pull request lookup fails", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#300";
	const deps = {
		...mockDependencies({
			commandOutput: JSON.stringify({ outcome: "repair_noop" }),
		}),
		getPullRequest: vi.fn().mockRejectedValue(new Error("fetch failed")),
	};

	try {
		await createWorkerRun(client, {
			id: "repair_planner_run",
			workItemId,
			kind: "repairer",
			status: "completed",
		});
		await createDecision(client, {
			id: buildPlan().decisionId,
			workItemId,
			workerRunId: "repair_planner_run",
			phase: "repair",
			outcome: "repair_allowed",
			policyRuleId: "format_fixable",
			evidence: {
				pullRequestNumber: baseMetadata.pullRequestNumber,
				classification: "format_fixable",
				repairExecutionKey: baseMetadata.repairExecutionKey,
				failureFingerprint: baseMetadata.detailFailureFingerprint,
				allowedChangedFiles: ["src/index.ts"],
			},
		});

		const result = await runRepairerExecutor({
			client,
			workItem: workItem(),
			workItemId,
			pullRequestNumber: baseMetadata.pullRequestNumber,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/303",
			checkSummary: buildCheckSummary(),
			repositoryBaseBranch: "main",
			plan: buildPlan(),
			owner: "toyamarinyon",
			repository: "rhapsody",
			dependencies: deps,
		});

		expect(result.executed).toBe(true);
		expect(result.outcome).toBe("repair_failed");

		const graph = await listWorkItemGraph(client, workItemId);
		expect(graph.decisions).toHaveLength(2);
		expect(
			graph.decisions.some((decision) => decision.outcome === "repair_failed"),
		).toBe(true);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerExecutor falls back to pull request files when evidence has no allowlist", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#300";
	let capturedMetadata: unknown;

	try {
		await createAllowedRepairPlanDecision(
			client,
			workItemId,
			buildPlan().decisionId,
			[],
		);

		const deps = mockDependencies({
			commandOutput: JSON.stringify({
				ok: true,
				outcome: "repair_noop",
			}),
			getPullRequestChangedFiles: async () => [
				"lib/github/issue-reference.test.ts",
			],
			writeMetadataCapture: (metadata) => {
				capturedMetadata = metadata;
			},
		});

		const result = await runRepairerExecutor({
			client,
			workItem: workItem(),
			workItemId,
			pullRequestNumber: baseMetadata.pullRequestNumber,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/304",
			checkSummary: buildCheckSummary(),
			repositoryBaseBranch: "main",
			plan: buildPlan(),
			owner: "toyamarinyon",
			repository: "rhapsody",
			dependencies: deps,
		});

		expect(result.executed).toBe(true);
		expect(result.outcome).toBe("repair_noop");
		expect(capturedMetadata).toMatchObject({
			allowedChangedFiles: ["lib/github/issue-reference.test.ts"],
			allowedChangedFilesSource: "pull_request_files",
		});
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerExecutor fails closed with no allowlist when PR file lookup is empty", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#300";

	try {
		await createAllowedRepairPlanDecision(
			client,
			workItemId,
			"repair_planner_decision",
			[],
		);

		const deps = mockDependencies({
			commandOutput: JSON.stringify({
				ok: true,
				outcome: "repair_applied",
				artifact: {
					sha: "new-sha",
					htmlUrl: "https://github.com/toyamarinyon/rhapsody/commit/new-sha",
					changedFiles: ["lib/github/issue-reference.test.ts"],
				},
			}),
			getPullRequestChangedFiles: async () => [],
		});

		const result = await runRepairerExecutor({
			client,
			workItem: workItem(),
			workItemId,
			pullRequestNumber: baseMetadata.pullRequestNumber,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/305",
			checkSummary: buildCheckSummary(),
			repositoryBaseBranch: "main",
			plan: buildPlan(),
			owner: "toyamarinyon",
			repository: "rhapsody",
			dependencies: deps,
		});

		expect(result.executed).toBe(true);
		expect(result.outcome).toBe("repair_failed");
		expect(deps.runVercelSandboxCommand).not.toHaveBeenCalled();
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerExecutor skips execution when active repairer run exists and does not create a new repair decision", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#300";

	await createWorkerRun(client, {
		id: "repairer-active",
		workItemId,
		kind: "repairer",
		status: "running",
		metadata: {
			repairExecutionKey: baseMetadata.repairExecutionKey,
		},
	});

	try {
		const result = await runRepairerExecutor({
			client,
			workItem: workItem(),
			workItemId,
			pullRequestNumber: baseMetadata.pullRequestNumber,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/300",
			checkSummary: buildCheckSummary(),
			repositoryBaseBranch: "main",
			plan: buildPlan(),
			owner: "toyamarinyon",
			repository: "rhapsody",
			dependencies: mockDependencies({
				commandOutput: JSON.stringify({ outcome: "repair_applied" }),
			}),
		});

		expect(result.executed).toBe(false);
		expect(result.outcome).toBe("repair_skipped_in_progress");

		const graph = await listWorkItemGraph(client, workItemId);
		expect(graph.workerRuns).toHaveLength(1);
		expect(graph.decisions).toHaveLength(0);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runRepairerExecutor skips execution when terminal repair outcome already exists", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#300";

	await createWorkerRun(client, {
		id: "repairer-terminal",
		workItemId,
		kind: "repairer",
		status: "completed",
	});
	await createDecision(client, {
		id: "repair_noop_terminal",
		workItemId,
		workerRunId: "repairer-terminal",
		phase: "repair",
		outcome: "repair_noop",
		evidence: {
			pullRequestNumber: baseMetadata.pullRequestNumber,
			classification: "format_fixable",
			repairExecutionKey: baseMetadata.repairExecutionKey,
			failureFingerprint: baseMetadata.detailFailureFingerprint,
			allowedChangedFiles: ["src/index.ts"],
		},
	});

	try {
		const result = await runRepairerExecutor({
			client,
			workItem: workItem(),
			workItemId,
			pullRequestNumber: baseMetadata.pullRequestNumber,
			pullRequestUrl: "https://github.com/toyamarinyon/rhapsody/pull/300",
			checkSummary: buildCheckSummary(),
			repositoryBaseBranch: "main",
			plan: buildPlan(),
			owner: "toyamarinyon",
			repository: "rhapsody",
			dependencies: mockDependencies({
				commandOutput: JSON.stringify({ outcome: "repair_applied" }),
			}),
		});

		expect(result.executed).toBe(false);
		expect(result.outcome).toBe("repair_skipped_terminal");

		const graph = await listWorkItemGraph(client, workItemId);
		expect(graph.workerRuns).toHaveLength(1);
		expect(graph.decisions).toHaveLength(1);
	} finally {
		client.close();
		database.cleanup();
	}
});
