import { afterEach, describe, expect, test, vi } from "vitest";
import * as credentials from "@/lib/codex/credentials";
import { createAdminSessionToken } from "@/lib/server/admin-session";
import { POST } from "./route";

describe("ChatGPT backend probe route", () => {
	const originalRootPassword = process.env.ROOT_PASSWORD;
	const originalAuthSecret = process.env.AUTH_SECRET;

	afterEach(() => {
		if (originalRootPassword === undefined) {
			delete process.env.ROOT_PASSWORD;
		} else {
			process.env.ROOT_PASSWORD = originalRootPassword;
		}
		if (originalAuthSecret === undefined) {
			delete process.env.AUTH_SECRET;
		} else {
			process.env.AUTH_SECRET = originalAuthSecret;
		}
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	test("probes ChatGPT backend with mediator credentials without exposing tokens", async () => {
		process.env.ROOT_PASSWORD = "root";
		vi.spyOn(credentials, "loadMediatorCredentialState").mockResolvedValue({
			accessToken: "access-token-secret",
			refreshToken: "refresh-token-secret",
			accountId: "acct_test",
		});
		const fetchMock = vi.fn().mockResolvedValue(
			new Response('{"models":["ok"],"access_token":"secret-value"}', {
				status: 200,
				statusText: "OK",
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
				},
			}),
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			ok: boolean;
			upstream: {
				url: string;
				status: number;
				bodyPreview: string;
			};
			credential: { accountIdPresent: boolean };
		};
		expect(body.ok).toBe(true);
		expect(body.upstream.url).toBe(
			"https://chatgpt.com/backend-api/codex/models",
		);
		expect(body.upstream.status).toBe(200);
		expect(body.upstream.bodyPreview).not.toContain("secret-value");
		expect(body.credential.accountIdPresent).toBe(true);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/codex/models?client_version=0.130.0",
			expect.objectContaining({
				headers: {
					authorization: "Bearer access-token-secret",
					"ChatGPT-Account-ID": "acct_test",
				},
			}),
		);
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

	test("accepts a signed admin session cookie", async () => {
		process.env.ROOT_PASSWORD = "root";
		process.env.AUTH_SECRET = "secret";
		vi.spyOn(credentials, "loadMediatorCredentialState").mockResolvedValue({
			accessToken: "access-token-secret",
			refreshToken: "refresh-token-secret",
			accountId: "acct_test",
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				new Response('{"models":["ok"]}', {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			),
		);
		const token = await createAdminSessionToken({ AUTH_SECRET: "secret" });

		const response = await POST(
			new Request("https://example.test/probe", {
				method: "POST",
				headers: {
					cookie: `rhapsody_admin_session=${token}`,
				},
			}),
		);

		expect(response.status).toBe(200);
	});
});
