import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { type Client, createClient } from "@libsql/client";
import { afterEach, expect, test, vi } from "vitest";
import {
	createClaimedManualRun,
	getRunDetail,
	markAttemptStarted,
	migrateStateStore,
} from "@/lib/state";
import { POST } from "./route";

const { resumeHook } = vi.hoisted(() => ({
	resumeHook: vi.fn(),
}));

vi.mock("workflow/api", () => ({
	resumeHook,
}));

async function createTestDatabase(): Promise<{
	client: Client;
	cleanup: () => void;
	url: string;
}> {
	const directory = mkdtempSync(path.join(tmpdir(), "rhapsody-callback-test-"));
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
	vi.clearAllMocks();
});

test("progress callback records an event without terminalizing attempt", async () => {
	const previousDatabaseUrl = process.env.TURSO_DATABASE_URL;
	const previousAuthToken = process.env.TURSO_AUTH_TOKEN;
	const previousMediatorSecret = process.env.MEDIATOR_SECRET;
	const database = await createTestDatabase();

	try {
		process.env.TURSO_DATABASE_URL = database.url;
		process.env.TURSO_AUTH_TOKEN = "test-token";
		process.env.MEDIATOR_SECRET = "mediator-secret";

		const claimed = await createClaimedManualRun(database.client, {
			runId: "run-progress",
			attemptId: "att-progress",
			claimToken: "claim-progress",
			workItemId: "github_issue:toyamarinyon/rhapsody#72",
			workItemTitle: "Progress callback test",
			runner: "sandbox-codex",
			claimedBy: "test",
			claimTtlMs: 60_000,
		});
		expect(claimed.acquired).toBe(true);

		const startResult = await markAttemptStarted(database.client, {
			runId: "run-progress",
			attemptId: "att-progress",
			claimToken: "claim-progress",
			sandboxId: "sandbox-progress",
			command: "sandbox-codex-runner",
		});
		expect(startResult.applied).toBe(true);

		const response = await POST(
			new Request("https://rhapsody.test/api/internal/runs/callback", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-rhapsody-mediator-secret": "mediator-secret",
				},
				body: JSON.stringify({
					callback_type: "progress",
					run_id: "run-progress",
					attempt_id: "att-progress",
					claim_token: "claim-progress",
					execution_status: "running",
					exit_code: null,
					sandbox_id: "sandbox-progress",
					command_id: "cmd-progress",
					started_at: "2026-05-24T00:00:00.000Z",
					error: "TOKEN=secret-value",
					diagnostics: {
						stdout_tail: "working\nOPENAI_API_KEY=secret-value",
						stderr_tail: "Bearer secret-token",
						stdout_bytes: 128,
						stderr_bytes: 24,
						last_output_at: "2026-05-24T00:00:30.000Z",
						last_stdout_at: "2026-05-24T00:00:29.000Z",
						last_stderr_at: "2026-05-24T00:00:28.000Z",
						last_codex_event_type: "agent_message",
						last_codex_error: "error: TOKEN=secret-value",
					},
				}),
			}),
		);

		expect(response.status).toBe(202);
		expect(resumeHook).not.toHaveBeenCalled();

		const detail = await getRunDetail(database.client, "run-progress");
		expect(detail?.run.status).toBe("running");
		expect(detail?.attempts[0]?.status).toBe("running");

		const progressEvent = detail?.events.find(
			(event) => event.type === "attempt.progress",
		);
		expect(progressEvent).toBeDefined();
		expect(progressEvent?.data).toMatchObject({
			callbackType: "progress",
			executionStatus: "running",
			sandboxId: "sandbox-progress",
			commandId: "cmd-progress",
			error: "TOKEN=[REDACTED]",
			diagnostics: {
				stdoutTail: "working\nOPENAI_API_KEY=[REDACTED]",
				stderrTail: "Bearer [REDACTED]",
				stdoutBytes: 128,
				stderrBytes: 24,
				lastCodexEventType: "agent_message",
				lastCodexError: "error: TOKEN=[REDACTED]",
			},
		});
		expect(progressEvent?.data).not.toHaveProperty("hookToken");
	} finally {
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
		if (previousMediatorSecret === undefined) {
			delete process.env.MEDIATOR_SECRET;
		} else {
			process.env.MEDIATOR_SECRET = previousMediatorSecret;
		}
		database.client.close();
		database.cleanup();
	}
});

test("unknown callback_type is rejected", async () => {
	const previousMediatorSecret = process.env.MEDIATOR_SECRET;

	try {
		process.env.MEDIATOR_SECRET = "mediator-secret";

		const response = await POST(
			new Request("https://rhapsody.test/api/internal/runs/callback", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-rhapsody-mediator-secret": "mediator-secret",
				},
				body: JSON.stringify({
					callback_type: "heartbeat",
					run_id: "run-progress",
					attempt_id: "att-progress",
					claim_token: "claim-progress",
					execution_status: "running",
				}),
			}),
		);

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: 'callback_type must be "terminal", "progress", null, or omitted.',
		});
		expect(resumeHook).not.toHaveBeenCalled();
	} finally {
		if (previousMediatorSecret === undefined) {
			delete process.env.MEDIATOR_SECRET;
		} else {
			process.env.MEDIATOR_SECRET = previousMediatorSecret;
		}
	}
});
