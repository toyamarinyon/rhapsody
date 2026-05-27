import { expect, test } from "vitest";

import {
	ADMIN_SESSION_COOKIE_NAME,
	createAdminSessionToken,
	readAdminSessionToken,
	sanitizeAdminNextPath,
	verifyAdminSessionToken,
} from "@/lib/server/admin-session";

test("creates and verifies an admin session token", async () => {
	const env = { AUTH_SECRET: "test-secret", ROOT_PASSWORD: "root" };
	const token = await createAdminSessionToken(env);

	expect(token).toContain(".");
	expect(await verifyAdminSessionToken(token, env)).toEqual({
		sub: "rhapsody-admin",
	});
});

test("rejects tampered admin session tokens", async () => {
	const env = { AUTH_SECRET: "test-secret", ROOT_PASSWORD: "root" };
	const token = await createAdminSessionToken(env);
	const tampered = `${token.slice(0, -1)}x`;

	expect(await verifyAdminSessionToken(tampered, env)).toBeNull();
});

test("reads the admin session token from cookies", () => {
	const request = new Request("https://example.test", {
		headers: {
			cookie: `${ADMIN_SESSION_COOKIE_NAME}=abc123; theme=dark`,
		},
	});

	expect(readAdminSessionToken(request)).toBe("abc123");
});

test("sanitizes login redirect targets to dashboard paths", () => {
	expect(sanitizeAdminNextPath("/dashboard/runs/run-123")).toBe(
		"/dashboard/runs/run-123",
	);
	expect(sanitizeAdminNextPath("/dashboard?tab=recent")).toBe(
		"/dashboard?tab=recent",
	);
	expect(sanitizeAdminNextPath("https://example.test/dashboard")).toBe(
		"/dashboard",
	);
	expect(sanitizeAdminNextPath("//evil.test/dashboard")).toBe("/dashboard");
	expect(sanitizeAdminNextPath("/api/v1/state")).toBe("/dashboard");
});
