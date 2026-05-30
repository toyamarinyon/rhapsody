import { afterEach, describe, expect, test, vi } from "vitest";
import * as credentials from "@/lib/codex/credentials";
import { handleAuthTokenExchange } from "./auth-token-exchange";

describe("codex chatgpt proxy route", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
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
