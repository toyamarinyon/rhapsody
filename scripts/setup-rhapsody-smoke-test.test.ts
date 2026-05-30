import { expect, test } from "vitest";
import { buildBlockedNextActions } from "@/scripts/setup-rhapsody-smoke-test";

test("blocks smoke-test with concrete recovery when state returns admin auth failure", () => {
	const nextActions = buildBlockedNextActions({
		baseCheck: {
			name: "base-url",
			url: "https://preview.vercel.app/",
			ok: true,
			status: 200,
			contentType: "text/html",
			classification: "ok",
		},
		stateCheck: {
			name: "api-state",
			url: "https://preview.vercel.app/api/v1/state",
			ok: false,
			status: 500,
			contentType: "application/json",
			classification: "admin-auth-missing",
		},
		loginOrDashboard: {
			name: "login-or-dashboard-path",
			url: "https://preview.vercel.app/login OR https://preview.vercel.app/dashboard",
			ok: true,
			status: 200,
			contentType: "text/html",
			classification: "reachable-path",
		},
	});

	expect(nextActions).toEqual([
		"Confirm ROOT_PASSWORD is configured in the preview deployment environment, redeploy if needed, then rerun `pnpm setup:smoke-test -- --url <preview-url> --use-root-password`.",
	]);
});
