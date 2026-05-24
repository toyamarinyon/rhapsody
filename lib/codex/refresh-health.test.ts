import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	loadMediatorCredentialState,
	saveMediatorCredentialState,
} from "@/lib/codex/credentials";
import {
	getCodexChatGptCredentialHealth,
	migrateStateStore,
} from "@/lib/state";
import { runChatGptRefreshHealthCheck } from "./refresh-health";

describe("runChatGptRefreshHealthCheck", () => {
	const originalDatabaseUrl = process.env.TURSO_DATABASE_URL;
	const originalAuthToken = process.env.TURSO_AUTH_TOKEN;
	const originalAuthSecret = process.env.AUTH_SECRET;

	afterEach(() => {
		restoreEnv("TURSO_DATABASE_URL", originalDatabaseUrl);
		restoreEnv("TURSO_AUTH_TOKEN", originalAuthToken);
		restoreEnv("AUTH_SECRET", originalAuthSecret);
		vi.restoreAllMocks();
	});

	test("persists successful refresh state and avoids duplicate steady-state events", async () => {
		const database = await createTestDatabase();
		configureStateStoreEnv(database.url);

		try {
			await saveMediatorCredentialState({
				accessToken: "access-old",
				refreshToken: "refresh-old",
				accountId: "acct_old",
			});

			const fetchMock = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						access_token: "access-new",
						refresh_token: "refresh-new",
						account_id: "acct_new",
					}),
					{
						status: 200,
						statusText: "OK",
						headers: {
							"content-type": "application/json",
						},
					},
				),
			);

			const firstResult = await runChatGptRefreshHealthCheck({
				now: 1_000,
				fetchImpl: fetchMock,
			});

			expect(firstResult).toEqual({
				ok: true,
				needsReauth: false,
				checkedAt: "1970-01-01T00:00:01.000Z",
				lastSucceededAt: "1970-01-01T00:00:01.000Z",
				upstreamStatus: 200,
				upstreamStatusText: "OK",
				errorCategory: null,
				eventRecorded: true,
			});
			expect(await loadMediatorCredentialState()).toEqual({
				accessToken: "access-new",
				refreshToken: "refresh-new",
				accountId: "acct_new",
			});
			expect(await getCodexChatGptCredentialHealth(database.client)).toEqual({
				ok: true,
				needsReauth: false,
				checkedAt: 1_000,
				lastSucceededAt: 1_000,
				upstreamStatus: 200,
				upstreamStatusText: "OK",
				errorCategory: null,
			});

			const firstEvents = await readHealthEvents(database.client);
			expect(firstEvents).toHaveLength(1);
			expect(firstEvents[0]?.type).toBe("codex.chatgpt_credentials_health.ok");
			expect(firstEvents[0]?.dataJson).not.toContain("refresh-new");
			expect(firstEvents[0]?.dataJson).not.toContain("access-new");
			expect(firstEvents[0]?.dataJson).not.toContain("refresh-old");

			const secondResult = await runChatGptRefreshHealthCheck({
				now: 2_000,
				fetchImpl: fetchMock,
			});

			expect(secondResult.eventRecorded).toBe(false);
			expect(await getCodexChatGptCredentialHealth(database.client)).toEqual({
				ok: true,
				needsReauth: false,
				checkedAt: 2_000,
				lastSucceededAt: 2_000,
				upstreamStatus: 200,
				upstreamStatusText: "OK",
				errorCategory: null,
			});
			expect(await readHealthEvents(database.client)).toHaveLength(1);
		} finally {
			database.client.close();
			database.cleanup();
		}
	});

	test("persists needsReauth failures, deduplicates repeats, and emits recovery", async () => {
		const database = await createTestDatabase();
		configureStateStoreEnv(database.url);

		try {
			await saveMediatorCredentialState({
				accessToken: "access-old",
				refreshToken: "refresh-old",
				accountId: "acct_old",
			});

			const failingFetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						error: "invalid_grant",
						error_description: "redacted",
					}),
					{
						status: 400,
						statusText: "Bad Request",
						headers: {
							"content-type": "application/json",
						},
					},
				),
			);

			const firstFailure = await runChatGptRefreshHealthCheck({
				now: 3_000,
				fetchImpl: failingFetch,
			});

			expect(firstFailure).toEqual({
				ok: false,
				needsReauth: true,
				checkedAt: "1970-01-01T00:00:03.000Z",
				lastSucceededAt: null,
				upstreamStatus: 400,
				upstreamStatusText: "Bad Request",
				errorCategory: "oauth_invalid_grant",
				eventRecorded: true,
			});
			expect(await getCodexChatGptCredentialHealth(database.client)).toEqual({
				ok: false,
				needsReauth: true,
				checkedAt: 3_000,
				lastSucceededAt: null,
				upstreamStatus: 400,
				upstreamStatusText: "Bad Request",
				errorCategory: "oauth_invalid_grant",
			});

			const repeatedFailure = await runChatGptRefreshHealthCheck({
				now: 4_000,
				fetchImpl: failingFetch,
			});

			expect(repeatedFailure.eventRecorded).toBe(false);
			const failureEvents = await readHealthEvents(database.client);
			expect(failureEvents).toHaveLength(1);
			expect(failureEvents[0]?.type).toBe(
				"codex.chatgpt_credentials_health.needs_reauth",
			);
			expect(failureEvents[0]?.dataJson).not.toContain("refresh-old");

			const recoveryFetch = vi.fn().mockResolvedValue(
				new Response(
					JSON.stringify({
						access_token: "access-recovered",
						refresh_token: "refresh-recovered",
						account_id: "acct_recovered",
					}),
					{
						status: 200,
						statusText: "OK",
						headers: {
							"content-type": "application/json",
						},
					},
				),
			);

			const recovery = await runChatGptRefreshHealthCheck({
				now: 5_000,
				fetchImpl: recoveryFetch,
			});

			expect(recovery).toEqual({
				ok: true,
				needsReauth: false,
				checkedAt: "1970-01-01T00:00:05.000Z",
				lastSucceededAt: "1970-01-01T00:00:05.000Z",
				upstreamStatus: 200,
				upstreamStatusText: "OK",
				errorCategory: null,
				eventRecorded: true,
			});
			expect(await loadMediatorCredentialState()).toEqual({
				accessToken: "access-recovered",
				refreshToken: "refresh-recovered",
				accountId: "acct_recovered",
			});
			expect(await readHealthEvents(database.client)).toHaveLength(2);
		} finally {
			database.client.close();
			database.cleanup();
		}
	});
});

async function createTestDatabase(): Promise<{
	client: Client;
	url: string;
	cleanup: () => void;
}> {
	const directory = mkdtempSync(path.join(tmpdir(), "rhapsody-test-"));
	const url = `file:${path.join(directory, "state.db")}`;
	const client = createClient({ url });
	await migrateStateStore(client);
	return {
		client,
		url,
		cleanup: () => rmSync(directory, { force: true, recursive: true }),
	};
}

function configureStateStoreEnv(url: string) {
	process.env.TURSO_DATABASE_URL = url;
	process.env.TURSO_AUTH_TOKEN = "test-auth-token";
	process.env.AUTH_SECRET = "test-auth-secret";
}

async function readHealthEvents(client: Client) {
	const result = await client.execute(`
		SELECT type, data_json
		FROM events
		WHERE type LIKE 'codex.chatgpt_credentials_health.%'
		ORDER BY created_at ASC
	`);

	return result.rows.map((row) => ({
		type: String(row.type),
		dataJson: String(row.data_json ?? ""),
	}));
}

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}

	process.env[name] = value;
}
