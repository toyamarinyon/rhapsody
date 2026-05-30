import { afterEach, describe, expect, test, vi } from "vitest";
import * as refreshHealth from "@/lib/codex/refresh-health";
import { GET, POST } from "./route";

describe("ChatGPT credential health-check route", () => {
	const originalRootPassword = process.env.ROOT_PASSWORD;
	const originalCronSecret = process.env.CRON_SECRET;

	afterEach(() => {
		restoreEnv("ROOT_PASSWORD", originalRootPassword);
		restoreEnv("CRON_SECRET", originalCronSecret);
		vi.restoreAllMocks();
	});

	test("requires cron or admin auth", async () => {
		process.env.ROOT_PASSWORD = "root";
		process.env.CRON_SECRET = "cron";

		const response = await GET(
			new Request("https://example.test/health-check", {
				method: "GET",
			}),
		);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "Unauthorized." });
	});

	test("supports cron auth and maps unhealthy state to 503", async () => {
		process.env.ROOT_PASSWORD = "root";
		process.env.CRON_SECRET = "cron";
		vi.spyOn(refreshHealth, "runChatGptRefreshHealthCheck").mockResolvedValue({
			ok: false,
			needsReauth: true,
			checkedAt: "2026-05-24T00:00:00.000Z",
			lastSucceededAt: "2026-05-23T00:00:00.000Z",
			upstreamStatus: 400,
			upstreamStatusText: "Bad Request",
			errorCategory: "oauth_invalid_grant",
			eventRecorded: true,
		});

		const response = await GET(
			new Request("https://example.test/health-check", {
				method: "GET",
				headers: {
					authorization: "Bearer cron",
				},
			}),
		);

		expect(response.status).toBe(503);
		expect(await response.json()).toMatchObject({
			ok: false,
			needsReauth: true,
			errorCategory: "oauth_invalid_grant",
		});
	});

	test("supports admin auth and returns 200 on healthy refresh", async () => {
		process.env.ROOT_PASSWORD = "root";
		delete process.env.CRON_SECRET;
		vi.spyOn(refreshHealth, "runChatGptRefreshHealthCheck").mockResolvedValue({
			ok: true,
			needsReauth: false,
			checkedAt: "2026-05-24T00:00:00.000Z",
			lastSucceededAt: "2026-05-24T00:00:00.000Z",
			upstreamStatus: 200,
			upstreamStatusText: "OK",
			errorCategory: null,
			eventRecorded: false,
		});

		const response = await POST(
			new Request("https://example.test/health-check", {
				method: "POST",
				headers: {
					authorization: "Bearer root",
				},
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			ok: true,
			needsReauth: false,
			upstreamStatus: 200,
		});
	});
});

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}

	process.env[name] = value;
}
