import { expect, test } from "vitest";

import { POST } from "./route";

test("successful login sets a session cookie and redirects back", async () => {
	const previousRootPassword = process.env.ROOT_PASSWORD;
	const previousAuthSecret = process.env.AUTH_SECRET;
	process.env.ROOT_PASSWORD = "root";
	process.env.AUTH_SECRET = "secret";

	try {
		const body = new FormData();
		body.set("password", "root");
		body.set("next", "/dashboard/runs/abc");

		const response = await POST(
			new Request("https://example.test/login", {
				method: "POST",
				body,
			}),
		);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toBe(
			"https://example.test/dashboard/runs/abc",
		);
		expect(response.headers.get("set-cookie")).toContain(
			"rhapsody_admin_session=",
		);
	} finally {
		restoreEnv("ROOT_PASSWORD", previousRootPassword);
		restoreEnv("AUTH_SECRET", previousAuthSecret);
	}
});

test("failed login redirects back to login with a delay", async () => {
	const previousRootPassword = process.env.ROOT_PASSWORD;
	const previousAuthSecret = process.env.AUTH_SECRET;
	process.env.ROOT_PASSWORD = "root";
	process.env.AUTH_SECRET = "secret";

	try {
		const body = new FormData();
		body.set("password", "nope");

		const response = await POST(
			new Request("https://example.test/login", {
				method: "POST",
				body,
			}),
		);

		expect(response.status).toBe(303);
		expect(response.headers.get("location")).toContain("/login?error=invalid");
	} finally {
		restoreEnv("ROOT_PASSWORD", previousRootPassword);
		restoreEnv("AUTH_SECRET", previousAuthSecret);
	}
});

test("login redirect targets stay within the dashboard", async () => {
	const previousRootPassword = process.env.ROOT_PASSWORD;
	const previousAuthSecret = process.env.AUTH_SECRET;
	process.env.ROOT_PASSWORD = "root";
	process.env.AUTH_SECRET = "secret";

	try {
		const body = new FormData();
		body.set("password", "root");
		body.set("next", "//evil.test/dashboard");

		const response = await POST(
			new Request("https://example.test/login", {
				method: "POST",
				body,
			}),
		);

		expect(response.headers.get("location")).toBe(
			"https://example.test/dashboard",
		);
	} finally {
		restoreEnv("ROOT_PASSWORD", previousRootPassword);
		restoreEnv("AUTH_SECRET", previousAuthSecret);
	}
});

function restoreEnv(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
		return;
	}

	process.env[name] = value;
}
