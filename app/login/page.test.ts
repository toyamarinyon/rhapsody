import { afterEach, describe, expect, test, vi } from "vitest";

const cookiesMock = vi.hoisted(() => vi.fn());
const redirectMock = vi.hoisted(() =>
	vi.fn((path: string) => {
		throw new Error(`redirect:${path}`);
	}),
);

vi.mock("next/headers", () => ({
	cookies: cookiesMock,
}));

vi.mock("next/navigation", () => ({
	redirect: redirectMock,
}));

import { createAdminSessionToken } from "@/lib/server/admin-session";
import LoginPage from "./page";

describe("LoginPage", () => {
	const originalRootPassword = process.env.ROOT_PASSWORD;
	const originalAuthSecret = process.env.AUTH_SECRET;

	afterEach(() => {
		restoreEnv("ROOT_PASSWORD", originalRootPassword);
		restoreEnv("AUTH_SECRET", originalAuthSecret);
		cookiesMock.mockReset();
		redirectMock.mockReset();
		redirectMock.mockImplementation((path: string) => {
			throw new Error(`redirect:${path}`);
		});
	});

	test("redirects already authenticated users to the sanitized next path", async () => {
		process.env.ROOT_PASSWORD = "root";
		process.env.AUTH_SECRET = "secret";
		const token = await createAdminSessionToken({ AUTH_SECRET: "secret" });
		cookiesMock.mockResolvedValue({
			get(name: string) {
				return name === "rhapsody_admin_session"
					? {
							value: token,
						}
					: undefined;
			},
		});

		await expect(
			LoginPage({
				searchParams: Promise.resolve({
					next: "https://example.com",
				}),
			}),
		).rejects.toThrow("redirect:/dashboard");
	});

	test("renders configuration error when auth is not configured", async () => {
		delete process.env.ROOT_PASSWORD;
		delete process.env.AUTH_SECRET;
		cookiesMock.mockResolvedValue({
			get() {
				return undefined;
			},
		});

		const element = await LoginPage({ searchParams: Promise.resolve({}) });

		expect(redirectMock).not.toHaveBeenCalled();
		expect(flattenText(element)).toContain(
			"Admin dashboard access requires both ROOT_PASSWORD and AUTH_SECRET.",
		);
	});
});

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}

	process.env[name] = value;
}

function flattenText(value: unknown): string {
	if (value === null || value === undefined || typeof value === "boolean") {
		return "";
	}

	if (typeof value === "string" || typeof value === "number") {
		return String(value);
	}

	if (Array.isArray(value)) {
		return value.map(flattenText).join("");
	}

	if (typeof value === "object" && value !== null && "props" in value) {
		const props = (value as { props?: { children?: unknown } }).props;
		return flattenText(props?.children);
	}

	return "";
}
