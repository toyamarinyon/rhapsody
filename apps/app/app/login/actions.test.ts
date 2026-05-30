import { afterEach, describe, expect, test, vi } from "vitest";

const { cookiesSet, headersMock, redirectMock } = vi.hoisted(() => ({
	cookiesSet: vi.fn(),
	headersMock: vi.fn(),
	redirectMock: vi.fn((path: string) => {
		throw new Error(`redirect:${path}`);
	}),
}));

vi.mock("next/headers", () => ({
	cookies: async () => ({ set: cookiesSet }),
	headers: headersMock,
}));

vi.mock("next/navigation", () => ({
	redirect: redirectMock,
}));

import { loginAction } from "./actions";

describe("loginAction", () => {
	const originalRootPassword = process.env.ROOT_PASSWORD;
	const originalAuthSecret = process.env.AUTH_SECRET;

	afterEach(() => {
		restoreEnv("ROOT_PASSWORD", originalRootPassword);
		restoreEnv("AUTH_SECRET", originalAuthSecret);
		vi.restoreAllMocks();
		cookiesSet.mockReset();
		headersMock.mockReset();
		redirectMock.mockReset();
		redirectMock.mockImplementation((path: string) => {
			throw new Error(`redirect:${path}`);
		});
	});

	test("sets an admin session cookie and redirects to the sanitized next path", async () => {
		process.env.ROOT_PASSWORD = "root";
		process.env.AUTH_SECRET = "auth-secret";
		headersMock.mockResolvedValue(
			new Headers({ "x-forwarded-proto": "https" }),
		);

		const formData = new FormData();
		formData.set("password", "root");
		formData.set("next", "/dashboard/runs/123");

		await expect(loginAction(formData)).rejects.toThrow(
			"redirect:/dashboard/runs/123",
		);

		expect(cookiesSet).toHaveBeenCalledWith(
			"rhapsody_admin_session",
			expect.stringMatching(/^ey/),
			expect.objectContaining({
				httpOnly: true,
				path: "/",
				sameSite: "lax",
				secure: true,
				maxAge: 60 * 60 * 24 * 7,
			}),
		);
	});

	test("delays and redirects back on invalid password without setting a cookie", async () => {
		process.env.ROOT_PASSWORD = "root";
		process.env.AUTH_SECRET = "auth-secret";
		headersMock.mockResolvedValue(new Headers({ "x-forwarded-proto": "http" }));
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: TimerHandler,
		) => {
			if (typeof callback === "function") {
				callback();
			}
			return 0 as unknown as number;
		}) as typeof setTimeout);

		const formData = new FormData();
		formData.set("password", "wrong");
		formData.set("next", "https://example.com");

		await expect(loginAction(formData)).rejects.toThrow(
			"redirect:/login?error=invalid&next=%2Fdashboard",
		);

		expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 750);
		expect(cookiesSet).not.toHaveBeenCalled();
	});

	test("treats missing auth configuration as a delayed configuration error", async () => {
		delete process.env.ROOT_PASSWORD;
		process.env.AUTH_SECRET = "auth-secret";
		headersMock.mockResolvedValue(
			new Headers({ "x-forwarded-proto": "https" }),
		);
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: TimerHandler,
		) => {
			if (typeof callback === "function") {
				callback();
			}
			return 0 as unknown as number;
		}) as typeof setTimeout);

		const formData = new FormData();
		formData.set("password", "root");
		formData.set("next", "/dashboard");

		await expect(loginAction(formData)).rejects.toThrow(
			"redirect:/login?error=configuration",
		);

		expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 750);
		expect(cookiesSet).not.toHaveBeenCalled();
	});
});

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}

	process.env[name] = value;
}
