import { expect, test } from "vitest";

import { requireAdminAuth } from "@/lib/server/admin-auth";
import { createAdminSessionToken } from "@/lib/server/admin-session";

test("accepts bearer token auth", async () => {
	const request = new Request("https://example.test", {
		headers: {
			authorization: "Bearer root",
		},
	});

	await expect(
		requireAdminAuth(request, {
			ROOT_PASSWORD: "root",
		}),
	).resolves.toEqual({ ok: true });
});

test("accepts signed session cookies", async () => {
	const token = await createAdminSessionToken({
		ROOT_PASSWORD: "root",
		AUTH_SECRET: "secret",
	});
	const request = new Request("https://example.test", {
		headers: {
			cookie: `rhapsody_admin_session=${token}`,
		},
	});

	await expect(
		requireAdminAuth(request, {
			ROOT_PASSWORD: "root",
			AUTH_SECRET: "secret",
		}),
	).resolves.toEqual({ ok: true });
});

test("rejects invalid auth without revealing config state", async () => {
	const request = new Request("https://example.test");
	const result = await requireAdminAuth(request, {
		ROOT_PASSWORD: "root",
		AUTH_SECRET: "secret",
	});

	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(await result.response.json()).toEqual({ error: "Unauthorized." });
		expect(result.response.status).toBe(401);
	}
});

test("returns a configuration error when the root password is missing", async () => {
	const request = new Request("https://example.test");
	const result = await requireAdminAuth(request, {
		AUTH_SECRET: "secret",
	});

	expect(result.ok).toBe(false);
	if (!result.ok) {
		expect(result.response.status).toBe(500);
		expect(await result.response.json()).toEqual({
			error: "Admin auth is not configured.",
		});
	}
});
