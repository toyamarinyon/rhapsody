import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { afterEach, expect, test, vi } from "vitest";
import { runnerWorkflow } from "@/workflows/runner";
import {
	createClaimedManualRun,
	getRunDetail,
	migrateStateStore,
} from "@/lib/state";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
	startMock: vi.fn(),
}));

vi.mock("workflow/api", () => ({
	start: mocks.startMock,
}));

async function createTestDatabase(): Promise<{
	client: Client;
	cleanup: () => void;
	url: string;
}> {
	const directory = mkdtempSync(path.join(tmpdir(), "rhapsody-start-test-"));
	const url = `file:${path.join(directory, "state.db")}`;
	const client = createClient({ url });
	await migrateStateStore(client);

	return {
		client,
		url,
		cleanup: () => rmSync(directory, { force: true, recursive: true }),
	};
}

afterEach(() => {
	mocks.startMock.mockReset();
	vi.clearAllMocks();
});

test("manual start endpoint stores runner workflow run id", async () => {
	const previousRootPassword = process.env.ROOT_PASSWORD;
	const previousDatabaseUrl = process.env.TURSO_DATABASE_URL;
	const previousAuthToken = process.env.TURSO_AUTH_TOKEN;
	const database = await createTestDatabase();

	process.env.ROOT_PASSWORD = "root";
	process.env.TURSO_DATABASE_URL = database.url;
	process.env.TURSO_AUTH_TOKEN = "auth-token";
	mocks.startMock.mockResolvedValueOnce({ runId: "workflow-manual-start" });

	try {
		const createResult = await createClaimedManualRun(database.client, {
			workItemId: "github_issue:toyamarinyon/rhapsody#101",
			workItemTitle: "Manual start route test",
			runner: "sandbox-codex",
			claimedBy: "manual",
			claimTtlMs: 60_000,
		});

		if (!createResult.acquired) {
			throw new Error("Manual run was not acquired for test setup.");
		}

		const response = await POST(
			new Request(
				"https://example.test/api/v1/runs/unused/attempts/unused/start",
				{
					method: "POST",
					headers: {
						authorization: "Bearer root",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						claimToken: createResult.claimToken,
						sandboxId: "sandbox-manual",
						command: "sandbox-codex-runner",
					}),
				},
			),
			{
				params: Promise.resolve({
					runId: createResult.runId,
					attemptId: createResult.attemptId,
				}),
			},
		);

		expect(response.status).toBe(202);
		expect(await response.json()).toMatchObject({
			runnerWorkflowRunId: "workflow-manual-start",
		});
		expect(mocks.startMock).toHaveBeenCalledWith(runnerWorkflow, [
			expect.objectContaining({
				runId: createResult.runId,
				attemptId: createResult.attemptId,
				startedBy: "manual",
			}),
		]);

		const detail = await getRunDetail(database.client, createResult.runId);
		expect(detail?.run.runnerWorkflowRunId).toBe("workflow-manual-start");
	} finally {
		if (previousRootPassword === undefined) {
			delete process.env.ROOT_PASSWORD;
		} else {
			process.env.ROOT_PASSWORD = previousRootPassword;
		}
		if (previousDatabaseUrl === undefined) {
			delete process.env.TURSO_DATABASE_URL;
		} else {
			process.env.TURSO_DATABASE_URL = previousDatabaseUrl;
		}
		if (previousAuthToken === undefined) {
			delete process.env.TURSO_AUTH_TOKEN;
		} else {
			process.env.TURSO_AUTH_TOKEN = previousAuthToken;
		}

		database.client.close();
		database.cleanup();
	}
});
