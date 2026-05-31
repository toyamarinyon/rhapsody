import { afterEach, describe, expect, test, vi } from "vitest";
import * as credentials from "@/lib/codex/credentials";
import { POST } from "./route";

describe("ChatGPT OAuth refresh probe route", () => {
	const originalRootPassword = process.env.ROOT_PASSWORD;

	afterEach(() => {
		if (originalRootPassword === undefined) {
			delete process.env.ROOT_PASSWORD;
		} else {
			process.env.ROOT_PASSWORD = originalRootPassword;
		}
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	test("requires admin auth", async () => {
		process.env.ROOT_PASSWORD = "root";
		const response = await POST(
			new Request("https://example.test/probe", {
				method: "POST",
			}),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized." });
	});

	test("success dry-run validates token fields without exposing values", async () => {
		process.env.ROOT_PASSWORD = "root";
		vi.spyOn(credentials, "loadMediatorCredentialState").mockResolvedValue({
			accessToken: "access-token-secret",
			refreshToken: "refresh-token-secret",
			accountId: "acct_test",
		});
		const updateSpy = vi
			.spyOn(credentials, "updateMediatorCredentialsFromOAuthResponse")
			.mockResolvedValue({
				accessToken: "new-access",
				refreshToken: "new-refresh",
				accountId: "acct_test",
			});
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					access_token: "new-access-token-value",
					refresh_token: "new-refresh-token-value",
					id_token: "new-id-token-value",
					account_id: "acct_test",
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
		vi.stubGlobal("fetch", fetchMock);

		const response = await POST(
			new Request("https://example.test/probe", {
				method: "POST",
				headers: {
					authorization: "Bearer root",
				},
			}),
		);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
		expect(body.persisted).toBe(false);
		expect(body.returned).toEqual({
			accessTokenPresent: true,
			refreshTokenPresent: true,
			idTokenPresent: true,
			accountIdPresent: true,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://auth.openai.com/oauth/token",
			expect.objectContaining({
				method: "POST",
				headers: { "content-type": "application/json" },
			}),
		);
		expect(updateSpy).not.toHaveBeenCalled();
	});

	test("success persist=true calls credential update", async () => {
		process.env.ROOT_PASSWORD = "root";
		vi.spyOn(credentials, "loadMediatorCredentialState").mockResolvedValue({
			accessToken: "access-token-secret",
			refreshToken: "refresh-token-secret",
			accountId: "acct_test",
		});
		const updateSpy = vi
			.spyOn(credentials, "updateMediatorCredentialsFromOAuthResponse")
			.mockResolvedValue({
				accessToken: "new-access",
				refreshToken: "new-refresh",
				accountId: "acct_test",
			});
		const fetchMock = vi.fn().mockResolvedValue(
			new Response('{"access_token":"x","refresh_token":"y","id_token":"z"}', {
				status: 200,
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await POST(
			new Request("https://example.test/probe", {
				method: "POST",
				headers: {
					authorization: "Bearer root",
					"content-type": "application/json",
				},
				body: JSON.stringify({ persist: true }),
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ persisted: true });
		expect(updateSpy).toHaveBeenCalledTimes(1);
		expect(updateSpy).toHaveBeenCalledWith(
			{
				accessToken: "access-token-secret",
				refreshToken: "refresh-token-secret",
				accountId: "acct_test",
			},
			expect.any(Object),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://auth.openai.com/oauth/token",
			expect.any(Object),
		);
		const upstreamBody = JSON.parse(
			String((fetchMock.mock.calls[0]?.[1] as RequestInit).body),
		) as Record<string, string>;
		expect(upstreamBody).toMatchObject({
			client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
			grant_type: "refresh_token",
			refresh_token: "refresh-token-secret",
		});
	});

	test("upstream failure with persist=true does not update credentials", async () => {
		process.env.ROOT_PASSWORD = "root";
		vi.spyOn(credentials, "loadMediatorCredentialState").mockResolvedValue({
			accessToken: "access-token-secret",
			refreshToken: "refresh-token-secret",
			accountId: "acct_test",
		});
		const updateSpy = vi
			.spyOn(credentials, "updateMediatorCredentialsFromOAuthResponse")
			.mockResolvedValue({
				accessToken: "new-access",
				refreshToken: "new-refresh",
				accountId: "acct_test",
			});
		const fetchMock = vi.fn().mockResolvedValue(
			new Response('{"error":"invalid_grant"}', {
				status: 400,
				headers: {
					"content-type": "application/json",
				},
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await POST(
			new Request("https://example.test/probe", {
				method: "POST",
				headers: {
					authorization: "Bearer root",
					"content-type": "application/json",
				},
				body: JSON.stringify({ persist: true }),
			}),
		);

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ persisted: false });
		expect(updateSpy).not.toHaveBeenCalled();
	});

	test("upstream failure redacts body and keeps credentials safe", async () => {
		process.env.ROOT_PASSWORD = "root";
		vi.spyOn(credentials, "loadMediatorCredentialState").mockResolvedValue({
			accessToken: "access-token-secret",
			refreshToken: "refresh-token-secret",
			accountId: "acct_test",
		});
		vi.spyOn(credentials, "updateMediatorCredentialsFromOAuthResponse");
		const fetchMock = vi.fn().mockResolvedValue(
			new Response(
				'{"error":"invalid_grant","error_description":"Bad refresh_token: refresh-token-secret"}',
				{
					status: 400,
					statusText: "Bad Request",
					headers: {
						"content-type": "application/json",
					},
				},
			),
		);
		vi.stubGlobal("fetch", fetchMock);

		const response = await POST(
			new Request("https://example.test/probe", {
				method: "POST",
				headers: {
					authorization: "Bearer root",
				},
			}),
		);

		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.ok).toBe(false);
		expect(body.upstream.bodyPreview).not.toContain("refresh-token-secret");
		expect(body.upstream.bodyPreview).not.toContain("access-token-secret");
	});

	test("missing credential returns safe error", async () => {
		process.env.ROOT_PASSWORD = "root";
		vi.spyOn(credentials, "loadMediatorCredentialState").mockResolvedValue({
			accessToken: "",
			refreshToken: "",
			accountId: "",
		});

		const response = await POST(
			new Request("https://example.test/probe", {
				method: "POST",
				headers: {
					authorization: "Bearer root",
				},
			}),
		);

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({
			ok: false,
			error: "Missing ChatGPT refresh credentials.",
		});
	});
});
