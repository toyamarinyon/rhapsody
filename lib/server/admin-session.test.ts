import { expect, test } from "vitest";

import {
	ADMIN_SESSION_COOKIE_NAME,
	buildAdminSessionCookieOptions,
	createAdminSessionToken,
	isSecureRequest,
	readAdminSessionToken,
	sanitizeAdminNextPath,
	verifyAdminPassword,
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

test("detects secure requests from forwarded proto", () => {
	expect(isSecureRequest(new Headers({ "x-forwarded-proto": "https" }))).toBe(
		true,
	);
	expect(isSecureRequest(new Headers({ "x-forwarded-proto": "http" }))).toBe(
		false,
	);
});

test("builds cookie options for server actions", () => {
	expect(buildAdminSessionCookieOptions(true)).toMatchObject({
		httpOnly: true,
		path: "/",
		sameSite: "lax",
		secure: true,
		maxAge: 60 * 60 * 24 * 7,
	});
});

test("verifies passwords without accepting different-length inputs", () => {
	expect(verifyAdminPassword("root", "root")).toBe(true);
	expect(verifyAdminPassword("root", "other")).toBe(false);
	expect(verifyAdminPassword("", "other")).toBe(false);
	expect(verifyAdminPassword("root\0", "root")).toBe(false);
});
