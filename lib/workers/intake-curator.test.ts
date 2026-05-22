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
	runIntakeCurator,
	isIntakeBuildable,
} from "@/lib/workers/intake-curator";

const baseItem = {
	issueNumber: 210,
	issueTitle: "Small fix request",
	issueBody: "This is a full sentence body for intake validation.",
	repository: {
		owner: "toyamarinyon",
		name: "rhapsody",
	},
};

test("runIntakeCurator dedupes by evidence and returns existing decision id", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#210";

	try {
		const workerRun = await createWorkerRun(client, {
			id: "wrn_existing",
			workItemId,
			kind: "intake_curator",
			status: "completed",
		});

		const existingDecisionId = await createDecision(client, {
			id: "dec_existing",
			workItemId,
			workerRunId: workerRun.id,
			phase: "intake",
			outcome: "buildable",
			evidence: {
				issueNumber: baseItem.issueNumber,
				issueTitle: baseItem.issueTitle,
				issueBodyPreview: baseItem.issueBody.slice(0, 120),
			},
		});

		const workItem = buildProjectItem({
			issueNumber: baseItem.issueNumber,
			issueTitle: baseItem.issueTitle,
			issueBody: baseItem.issueBody,
		});

		const result = await runIntakeCurator(client, workItem, workItemId, {
			existingDecisions: [
				{
					id: existingDecisionId,
					workItemId,
					workerRunId: workerRun.id,
					phase: "intake",
					outcome: "buildable",
					deterministic: true,
					policyVersion: null,
					policyRuleId: null,
					evidence: {
						issueNumber: baseItem.issueNumber,
						issueTitle: baseItem.issueTitle,
						issueBodyPreview: baseItem.issueBody.slice(0, 120),
					},
					nextWorkerKind: null,
					nextAction: null,
					createdAt: 0,
					updatedAt: 0,
				},
			],
		});

		expect(result.decisionId).toBe(existingDecisionId);
		expect(result.skippedFreshDuplicate).toBe(true);
		expect(result.workerRunId).toBeNull();
		expect(result.shouldStartBuilder).toBe(true);

		const graph = await listWorkItemGraph(client, workItemId);
		expect(graph.decisions).toHaveLength(1);
		expect(graph.workerRuns).toHaveLength(1);
	} finally {
		client.close();
		database.cleanup();
	}
});

test("runIntakeCurator builds ask_human decision when intake is not buildable", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const workItemId = "github_issue:toyamarinyon/rhapsody#211";

	try {
		const workItem = buildProjectItem({
			issueNumber: 211,
			issueTitle: "Nope",
			issueBody: "short",
		});

		const result = await runIntakeCurator(client, workItem, workItemId);

		expect(result.outcome).toBe("ask_human");
		expect(result.shouldStartBuilder).toBe(false);
		expect(result.nextAction).toBe(
			"Please add a non-empty title and at least a short body before builder dispatch.",
		);
		expect(result.skippedFreshDuplicate).toBe(false);

		const graph = await listWorkItemGraph(client, workItemId);
		expect(graph.decisions).toHaveLength(1);
		expect(graph.decisions[0]?.outcome).toBe("ask_human");
		expect(graph.decisions[0]?.evidence).toEqual(
			expect.objectContaining({
				issueNumber: 211,
				issueTitle: "Nope",
				issueBodyPreview: "short",
			}),
		);
		expect(isIntakeBuildable(workItem)).toBe(false);
	} finally {
		client.close();
		database.cleanup();
	}
});

function buildProjectItem(input: {
	issueNumber: number;
	issueTitle: string;
	issueBody?: string | null;
}): Parameters<typeof runIntakeCurator>[1] {
	return {
		issueNumber: input.issueNumber,
		issueTitle: input.issueTitle,
		issueUrl: `https://github.com/toyamarinyon/rhapsody/issues/${input.issueNumber}`,
		issueState: "OPEN",
		issueBody: input.issueBody ?? "",
		projectStatus: "Todo",
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
