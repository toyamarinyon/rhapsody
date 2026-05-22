import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { expect, test } from "vitest";

import {
	createWorkerRun,
	migrateStateStore,
	type WorkItemGraph,
} from "@/lib/state";
import {
	loadWorkItemGraphForRouteParam,
	parseEncodedWorkItemIdParam,
} from "@/lib/server/work-item-graph";

test("parseEncodedWorkItemIdParam decodes a single encoded work item id", () => {
	const workItemId = "github_issue:toyamarinyon/rhapsody#51";
	const parsed = parseEncodedWorkItemIdParam(encodeURIComponent(workItemId));

	expect(parsed).toEqual({
		ok: true,
		value: workItemId,
	});
});

test("parseEncodedWorkItemIdParam reconstructs catch-all work item segments", () => {
	const parsed = parseEncodedWorkItemIdParam([
		"github_issue:toyamarinyon",
		"rhapsody#51",
	]);

	expect(parsed).toEqual({
		ok: true,
		value: "github_issue:toyamarinyon/rhapsody#51",
	});
});

test("parseEncodedWorkItemIdParam rejects invalid URI encoding", () => {
	const parsed = parseEncodedWorkItemIdParam("%E0%A4%A");

	expect(parsed).toEqual({
		ok: false,
		error: "encodedWorkItemId must be a valid URL-encoded work item id.",
	});
});

test(
	"loadWorkItemGraphForRouteParam returns an empty graph when no rows exist",
	async () => {
		const database = await createTestDatabase();
		const client = database.client;
		const workItemId = "github_issue:toyamarinyon/rhapsody#404";

		try {
			const result = await loadWorkItemGraphForRouteParam(
				client,
				encodeURIComponent(workItemId),
			);

			expect(result).toEqual({
				ok: true,
				graph: createEmptyGraph(workItemId),
			});
		} finally {
			client.close();
			database.cleanup();
		}
	},
);

test(
	"loadWorkItemGraphForRouteParam looks up graph rows using the decoded work item id",
	async () => {
		const database = await createTestDatabase();
		const client = database.client;
		const workItemId = "github_issue:toyamarinyon/rhapsody#51";

		try {
			await createWorkerRun(client, {
				id: "wrn_graph_lookup",
				workItemId,
				kind: "builder",
				status: "completed",
			});

			const result = await loadWorkItemGraphForRouteParam(
				client,
				encodeURIComponent(workItemId),
			);

			expect(result.ok).toBe(true);

			if (!result.ok) {
				throw new Error(result.error);
			}

			expect(result.graph.workItemId).toBe(workItemId);
			expect(result.graph.workerRuns.map((run) => run.id)).toEqual([
				"wrn_graph_lookup",
			]);
			expect(result.graph.decisions).toEqual([]);
			expect(result.graph.artifacts).toEqual([]);
			expect(result.graph.links).toEqual([]);
		} finally {
			client.close();
			database.cleanup();
		}
	},
);

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

function createEmptyGraph(workItemId: string): WorkItemGraph {
	return {
		workItemId,
		workerRuns: [],
		decisions: [],
		artifacts: [],
		links: [],
	};
}
