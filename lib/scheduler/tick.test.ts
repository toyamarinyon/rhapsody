import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createClient, type Client } from "@libsql/client";

import { runSchedulerTick, type SchedulerTickDependencies } from "./tick";
import {
	createArtifact,
	createWorkerRun,
	listWorkItemGraph,
	migrateStateStore,
} from "@/lib/state";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";

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
			updateProjectIssueStatus: async () => ({
				projectId: "project",
				itemId: "item",
				fieldId: "field",
				optionId: "option",
				status: "In Progress",
			}),
		});

		assert.equal(result.ok, true);
		if (!result.ok) {
			return;
		}

		assert.equal(result.value.created, 1);
		const graph = await listWorkItemGraph(
			client,
			"github_issue:toyamarinyon/rhapsody#101",
		);

		assert.equal(
			graph.workerRuns.some((run) => run.kind === "intake_curator"),
			true,
		);
		assert.equal(
			graph.workerRuns.some((run) => run.kind === "builder"),
			true,
		);
		assert.equal(
			graph.decisions.some(
				(decision) =>
					decision.phase === "intake" && decision.outcome === "buildable",
			),
			true,
		);
		assert.equal(
			graph.decisions.some(
				(decision) =>
					decision.phase === "dispatch" && decision.outcome === "start_builder",
			),
			true,
		);
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
		});

		assert.equal(result.ok, true);
		if (!result.ok) {
			return;
		}

		assert.equal(result.value.created, 0);
		assert.deepEqual(result.value.skippedIssues, [
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
		assert.equal(
			graph.decisions.some(
				(decision) =>
					decision.phase === "intake" && decision.outcome === "ask_human",
			),
			true,
		);
		assert.equal(
			graph.workerRuns.some((run) => run.kind === "builder"),
			false,
		);
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
		const result = await runSchedulerTick(client, {
			config: baseConfig,
			fetchProjectIssueWorkItems: async () => [item],
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

		assert.equal(result.ok, true);
		const graph = await listWorkItemGraph(client, workItemId);

		assert.equal(
			graph.decisions.some(
				(decision) =>
					decision.phase === "post_pr" && decision.outcome === "ci_failed",
			),
			true,
		);
		assert.equal(
			graph.decisions.some(
				(decision) =>
					decision.phase === "repair" && decision.outcome === "repair_allowed",
			),
			true,
		);
		assert.equal(
			graph.workerRuns.some((run) => run.kind === "repairer"),
			true,
		);
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
		repository: {
			owner: "toyamarinyon",
			name: "rhapsody",
		},
	};
}
