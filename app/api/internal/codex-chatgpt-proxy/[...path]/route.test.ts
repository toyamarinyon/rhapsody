import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as credentials from "@/lib/codex/credentials";
import * as state from "@/lib/state";
import {
	buildExpectedOidcAudience,
	handleAuthTokenExchange,
	isProxyRunContextActive,
	type ProxyRunContext,
	parseProxyPath,
} from "./route";

describe("codex chatgpt proxy path and run context auth", () => {
	let restoreProjectId: string | undefined;
	let restoreTeamId: string | undefined;

	beforeEach(() => {
		restoreProjectId = process.env.VERCEL_PROJECT_ID;
		restoreTeamId = process.env.VERCEL_TEAM_ID;
		process.env.VERCEL_PROJECT_ID = "prj_123";
		process.env.VERCEL_TEAM_ID = "team_123";
	});

	afterEach(() => {
		if (restoreProjectId === undefined) {
			delete process.env.VERCEL_PROJECT_ID;
		} else {
			process.env.VERCEL_PROJECT_ID = restoreProjectId;
		}
		if (restoreTeamId === undefined) {
			delete process.env.VERCEL_TEAM_ID;
		} else {
			process.env.VERCEL_TEAM_ID = restoreTeamId;
		}
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	test("parseProxyPath supports runs/ID/attempts/ID with upstream codex/chatgpt paths", () => {
		const parsed = parseProxyPath([
			"runs",
			"run-1",
			"attempts",
			"github_issue%3Aabc%231",
			"codex",
			"chatgpt",
			"backend-api",
			"responses",
		]);

		expect(parsed.runContext).toEqual({
			runId: "run-1",
			attemptId: "github_issue%3Aabc%231",
			audienceSuffix: "/codex/chatgpt",
		});
		expect(parsed.upstreamPath).toBe("/backend-api/responses");
		expect(
			buildExpectedOidcAudience(
				"https://example.com",
				parsed.runContext as ProxyRunContext,
			),
		).toBe(
			"https://example.com/api/internal/codex-chatgpt-proxy/runs/run-1/attempts/github_issue%3Aabc%231/codex/chatgpt",
		);
	});

	test("isProxyRunContextActive validates legacy run/attempt context", async () => {
		const client = { close: vi.fn() } as never;
		const getRunDetail = vi.spyOn(state, "getRunDetail").mockResolvedValue({
			run: { status: "running", workItemId: "workitem" } as never,
			attempts: [{ id: "attempt-1", status: "running" } as never],
			events: [],
			claim: null,
		}) as never;

		vi.spyOn(state, "createStateStoreClient").mockReturnValue(client);

		expect(
			await isProxyRunContextActive({
				runId: "run-1",
				attemptId: "attempt-1",
				audienceSuffix: "",
			}),
		).toBe(true);
		expect(getRunDetail).toHaveBeenCalledTimes(1);
	});

	test("isProxyRunContextActive validates intake run-context via work item id", async () => {
		const client = { close: vi.fn() } as never;
		const workItemId = "github_issue:org/repo#12";
		const encodedWorkItemId = Buffer.from(workItemId, "utf8").toString(
			"base64url",
		);

		vi.spyOn(state, "getRunDetail").mockResolvedValue(null);
		vi.spyOn(state, "listWorkItemGraph").mockResolvedValue({
			workItemId,
			workerRuns: [
				{
					id: "wrn-intake",
					workItemId,
					kind: "intake_curator",
					status: "running",
					metadata: {},
					workItemSnapshot: {},
					startedAt: 1,
					finishedAt: null,
					createdAt: 1,
					updatedAt: 1,
				} as never,
			],
			decisions: [],
			artifacts: [],
			links: [],
		} as never);
		vi.spyOn(state, "createStateStoreClient").mockReturnValue(client);

		expect(
			await isProxyRunContextActive({
				runId: "wrn-intake",
				attemptId: encodedWorkItemId,
				audienceSuffix: "",
			}),
		).toBe(true);
		expect(
			await isProxyRunContextActive({
				runId: "wrn-intake",
				attemptId: Buffer.from("github_issue:other#12", "utf8").toString(
					"base64url",
				),
				audienceSuffix: "",
			}),
		).toBe(false);
		expect(
			await isProxyRunContextActive({
				runId: "wrn-intake",
				attemptId: "%",
				audienceSuffix: "",
			}),
		).toBe(false);
	});

	test("handleAuthTokenExchange uses mediator fixed client_id", async () => {
		vi.spyOn(credentials, "loadMediatorCredentialState").mockResolvedValue({
			refreshToken: "refresh-token-DB",
			accessToken: "access-token",
			accountId: "acct_test",
		});
		vi.spyOn(
			credentials,
			"updateMediatorCredentialsFromOAuthResponse",
		).mockResolvedValue({
			accessToken: "access-token-new",
			refreshToken: "refresh-token-new",
			accountId: "acct_test",
		});

		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				'{"access_token":"upstream-access","refresh_token":"upstream-refresh","id_token":"upstream-id"}',
				{
					status: 200,
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const upstreamRequestBody = {
			client_id: "sandbox-client-id-override",
			grant_type: "authorization_code",
			refresh_token: "sandbox-refresh-token",
		};

		const response = await handleAuthTokenExchange(
			new Request("https://example.test/token", {
				method: "POST",
			}),
			new TextEncoder().encode(JSON.stringify(upstreamRequestBody)).buffer,
			"POST",
		);

		expect(response.status).toBe(200);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const fetchedRequestInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
		const parsedUpstreamBody = JSON.parse(
			String(fetchedRequestInit.body),
		) as Record<string, string>;
		expect(parsedUpstreamBody.client_id).toBe("app_EMoamEEZ73f0CkXaXp7hrann");
		expect(parsedUpstreamBody.grant_type).toBe("refresh_token");
		expect(parsedUpstreamBody.refresh_token).toBe("refresh-token-DB");
	});
});
