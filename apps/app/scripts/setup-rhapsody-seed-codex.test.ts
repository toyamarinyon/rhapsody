import { expect, test } from "vitest";
import {
	extractErrorSnippets,
	buildSeedFailureNextActions,
	buildSeedEndpoints,
	normalizeBaseUrl,
	parseArgs,
	classifyStatus,
	summarizeSeedResponse,
	summarizeHealthResponse,
} from "@/scripts/setup-rhapsody-seed-codex";

test("parses dry-run and apply arguments", () => {
	expect(
		parseArgs(["node", "script.ts", "--url", "https://preview.vercel.app"]),
	).toEqual({
		ok: true,
		mode: "dry-run",
		url: "https://preview.vercel.app",
		useRootPassword: false,
		apply: false,
		yes: false,
	});

	expect(
		parseArgs([
			"node",
			"script.ts",
			"--url",
			"https://preview.vercel.app",
			"--apply",
			"--yes",
			"--use-root-password",
		]),
	).toEqual({
		ok: true,
		mode: "apply",
		url: "https://preview.vercel.app",
		useRootPassword: true,
		apply: true,
		yes: true,
	});

	expect(
		parseArgs([
			"node",
			"script.ts",
			"--url",
			"https://preview.vercel.app",
			"--dry-run",
			"--apply",
			"--yes",
		]),
	).toEqual({
		ok: false,
		error:
			"Unsupported argument combination. Use neither flag for dry-run or exact --apply --yes --use-root-password.",
	});

	expect(parseArgs(["node", "script.ts", "--url"])).toEqual({
		ok: false,
		error: "The --url argument requires a value.",
	});
	expect(
		parseArgs(["node", "script.ts", "--url", "https://x", "--apply"]),
	).toEqual({
		ok: false,
		error:
			"Unsupported argument combination. Use exact --apply --yes --use-root-password.",
	});
	expect(
		parseArgs(["node", "script.ts", "--url", "https://x", "--apply", "--yes"]),
	).toEqual({
		ok: false,
		error:
			"Unsupported argument combination. Use exact --apply --yes --use-root-password.",
	});
	expect(
		parseArgs(["node", "script.ts", "--url", "https://x", "--yes"]),
	).toEqual({
		ok: false,
		error: "Unsupported argument combination. Use --apply with --yes to run.",
	});
	expect(
		parseArgs(["node", "script.ts", "--apply", "--use-root-password"]),
	).toEqual({
		ok: false,
		error: "Missing required --url argument.",
	});
	expect(
		parseArgs(["node", "script.ts", "--url", "https://x", "--apply", "--yes"]),
	).toEqual({
		ok: false,
		error:
			"Unsupported argument combination. Use exact --apply --yes --use-root-password.",
	});
	expect(parseArgs(["node", "script.ts", "--unknown"])).toEqual({
		ok: false,
		error: "Unsupported argument: --unknown",
	});
});

test("builds concrete seed failure next actions by classification", () => {
	expect(buildSeedFailureNextActions("network-error", "seed")).toEqual([
		"Confirm the preview URL is the deployed Rhapsody app, then inspect the Vercel deployment logs before rerunning the seed command.",
	]);
	expect(buildSeedFailureNextActions("unauthorized", "seed")).toEqual([
		"Confirm ROOT_PASSWORD matches the preview deployment, then rerun with --apply --yes --use-root-password.",
	]);
	expect(buildSeedFailureNextActions("not-found", "seed")).toEqual([
		"Confirm this preview includes the Codex credential admin endpoints, then redeploy before rerunning the seed command.",
	]);
	expect(buildSeedFailureNextActions("server-error", "health")).toEqual([
		"Inspect the Vercel function logs for the Codex credential endpoint, then rerun after fixing the deployment or env issue.",
	]);
	expect(buildSeedFailureNextActions("status-418", "health")).toEqual([
		"Seed succeeded but health check failed. Review health response and retry once fixed.",
	]);
});

test("normalizes URLs and builds endpoints", () => {
	expect(normalizeBaseUrl("https://example.com/preview/")).toBe(
		"https://example.com/preview",
	);
	expect(normalizeBaseUrl("https://example.com")).toBe("https://example.com");
	expect(() => normalizeBaseUrl("http://example.com")).toThrow(
		"Only HTTPS URLs are supported.",
	);

	expect(buildSeedEndpoints("https://example.com/preview")).toEqual({
		seedFromEnv:
			"https://example.com/preview/api/v1/admin/codex-chatgpt-credentials/seed-from-env",
		healthCheck:
			"https://example.com/preview/api/v1/admin/codex-chatgpt-credentials/health-check",
	});
});

test("classifies HTTP statuses consistently", () => {
	expect(classifyStatus(200)).toBe("ok");
	expect(classifyStatus(401)).toBe("unauthorized");
	expect(classifyStatus(400)).toBe("validation-error");
	expect(classifyStatus(503)).toBe("server-error");
	expect(classifyStatus(418)).toBe("status-418");
});

test("extracts safe summary snippets from JSON-only strings", () => {
	expect(
		extractErrorSnippets({
			error: "Invalid seed payload",
			detail: "This is too long to expose if it exceeds the limit.".repeat(30),
			statusText: "ok",
		}),
	).toEqual(["error: Invalid seed payload", "statusText: ok"]);

	expect(extractErrorSnippets({ detail: 12 })).toEqual([]);
});

test("summarizes seed and health responses with safe fields only", () => {
	const seedSummary = summarizeSeedResponse({
		status: 200,
		contentType: "application/json",
		parsedBody: {
			seeded: true,
			accountIdPresent: false,
			updatedAt: "2026-05-30T00:00:00.000Z",
			error: "should_not_leak",
		},
	});

	expect(seedSummary).toEqual({
		status: 200,
		contentType: "application/json",
		classification: "ok",
		objectKeys: ["seeded", "accountIdPresent", "updatedAt", "error"],
		seeded: true,
		accountIdPresent: false,
		updatedAt: "2026-05-30T00:00:00.000Z",
		snippets: ["error: should_not_leak"],
	});

	const healthSummary = summarizeHealthResponse({
		status: 200,
		contentType: "application/json",
		parsedBody: {
			ok: true,
			needsReauth: false,
			upstreamStatus: 200,
		},
	});

	expect(healthSummary).toEqual({
		status: 200,
		contentType: "application/json",
		classification: "ok",
		objectKeys: ["ok", "needsReauth", "upstreamStatus"],
		responseBodyPresent: true,
		ok: true,
		needsReauth: false,
		upstreamStatus: 200,
	});
});
