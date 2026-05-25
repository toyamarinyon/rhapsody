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
	const directory = mkdtempSync(path.join(tmpdir(), "rhapsody-run-test-"));
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

test("manual run endpoint starts runner workflow and stores workflow run id", async () => {
	const previousRootPassword = process.env.ROOT_PASSWORD;
	const previousDatabaseUrl = process.env.TURSO_DATABASE_URL;
	const previousAuthToken = process.env.TURSO_AUTH_TOKEN;
	const database = await createTestDatabase();

	process.env.ROOT_PASSWORD = "root";
	process.env.TURSO_DATABASE_URL = database.url;
	process.env.TURSO_AUTH_TOKEN = "auth-token";
	mocks.startMock.mockResolvedValueOnce({ runId: "workflow-manual-run" });

	try {
		const createResult = await createClaimedManualRun(database.client, {
			workItemId: "github_issue:toyamarinyon/rhapsody#202",
			workItemTitle: "Manual run route test",
			runner: "sandbox-codex",
			claimedBy: "manual",
			claimTtlMs: 60_000,
		});

		if (!createResult.acquired) {
			throw new Error("Manual run was not acquired for test setup.");
		}

		const response = await POST(
			new Request(
				"https://example.test/api/v1/runs/run-202/attempts/att-202/run",
				{
					method: "POST",
					headers: {
						authorization: "Bearer root",
					},
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
			runnerWorkflowRunId: "workflow-manual-run",
		});
		expect(mocks.startMock).toHaveBeenCalledWith(runnerWorkflow, [
			expect.objectContaining({
				runId: createResult.runId,
				attemptId: createResult.attemptId,
				startedBy: "manual",
			}),
		]);

		const detail = await getRunDetail(database.client, createResult.runId);
		expect(detail?.run.runnerWorkflowRunId).toBe("workflow-manual-run");
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
