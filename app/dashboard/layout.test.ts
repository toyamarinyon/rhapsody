import { afterEach, expect, test, vi } from "vitest";

const cookiesMock = vi.hoisted(() => vi.fn());
const redirectMock = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
	cookies: cookiesMock,
}));

vi.mock("next/navigation", () => ({
	redirect: redirectMock,
}));

import DashboardLayout from "./layout";

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
	redirectMock.mockReset();
	cookiesMock.mockReset();
});

test("redirects unauthenticated dashboard requests to login", () => {
	process.env.ROOT_PASSWORD = "root";
	process.env.AUTH_SECRET = "secret";
	cookiesMock.mockReturnValue({
		get: vi.fn().mockReturnValue(undefined),
	});
	redirectMock.mockImplementation(() => {
		throw new Error("redirect");
	});

	expect(() => DashboardLayout({ children: "ok" })).toThrow("redirect");
	expect(redirectMock).toHaveBeenCalledWith("/login?next=%2Fdashboard");
});

test("renders children when a session cookie is present", () => {
	process.env.ROOT_PASSWORD = "root";
	process.env.AUTH_SECRET = "secret";
	cookiesMock.mockReturnValue({
		get: vi.fn().mockReturnValue({ value: "signed-token" }),
	});

	expect(DashboardLayout({ children: "ok" })).toBeTruthy();
	expect(redirectMock).not.toHaveBeenCalled();
});
