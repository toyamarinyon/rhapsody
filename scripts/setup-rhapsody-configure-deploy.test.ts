import { expect, test } from "vitest";
import {
	buildPlannedChanges,
	getConfigureDeployWriteKeys,
	parseConfigureDeployArgs,
} from "@/scripts/setup-rhapsody-configure-deploy";

type PlannedChangeInput = Parameters<typeof buildPlannedChanges>[0];

test("parses configure-deploy argument forms", () => {
	expect(parseConfigureDeployArgs(["node", "script.ts"])).toEqual({
		mode: "dry-run",
		includeCodexSeed: false,
	});
	expect(
		parseConfigureDeployArgs(["node", "script.ts", "--include-codex-seed"]),
	).toEqual({
		mode: "dry-run",
		includeCodexSeed: true,
	});
	expect(
		parseConfigureDeployArgs([
			"node",
			"script.ts",
			"--apply",
			"--yes",
			"--include-codex-seed",
		]),
	).toEqual({
		mode: "apply",
		includeCodexSeed: true,
	});
	expect(
		parseConfigureDeployArgs([
			"node",
			"script.ts",
			"--dry-run",
			"--apply",
			"--yes",
		]),
	).toBeNull();
	expect(
		parseConfigureDeployArgs([
			"node",
			"script.ts",
			"--",
			"--apply",
			"--yes",
			"--include-codex-seed",
		]),
	).toEqual({
		mode: "apply",
		includeCodexSeed: true,
	});
	expect(parseConfigureDeployArgs(["node", "script.ts", "--apply"])).toBeNull();
	expect(parseConfigureDeployArgs(["node", "script.ts", "--yes"])).toBeNull();
	expect(
		parseConfigureDeployArgs(["node", "script.ts", "--unknown"]),
	).toBeNull();
});

test("builds seed-aware write key list", () => {
	expect(getConfigureDeployWriteKeys(false)).not.toContain(
		"INITIAL_CHATGPT_AUTH_JSON",
	);
	expect(getConfigureDeployWriteKeys(true)).toContain(
		"INITIAL_CHATGPT_AUTH_JSON",
	);
});

test("plans seed inclusion explicitly in dry-run based on opt-in flag", () => {
	const buildPlanArgs = (includeCodexSeed: boolean): PlannedChangeInput => ({
		mode: "dry-run",
		includeCodexSeed,
		repo: {
			packageJsonExists: true,
			dbMigrateScriptExists: true,
			vercelProjectJson: {
				exists: true,
				orgIdPresent: true,
				projectIdPresent: true,
				teamIdPresent: true,
			},
			inferredVercelContext: {
				teamIdPresent: true,
				projectIdPresent: true,
			},
		},
		remoteEnvPlan: {
			requiredRuntime: {
				ROOT_PASSWORD: { source: "process", available: true },
				AUTH_SECRET: { source: "process", available: true },
				CRON_SECRET: { source: "process", available: true },
				MEDIATOR_SECRET: { source: "process", available: true },
				TURSO_DATABASE_URL: { source: "process", available: true },
				TURSO_AUTH_TOKEN: { source: "process", available: true },
				GITHUB_TOKEN: { source: "process", available: true },
				VERCEL_TOKEN: { source: "process", available: true },
				VERCEL_TEAM_ID: { source: "process", available: true },
				VERCEL_PROJECT_ID: { source: "process", available: true },
			},
			runnerSeed: {
				INITIAL_CHATGPT_AUTH_JSON: {
					source: "process",
					available: true,
				},
			},
			optional: {},
		},
	});

	const noSeedPlan = buildPlannedChanges(buildPlanArgs(false));
	const withSeedPlan = buildPlannedChanges(buildPlanArgs(true));

	expect(noSeedPlan[2].action).toContain(
		"Runner seed INITIAL_CHATGPT_AUTH_JSON is available but not included by default; add --include-codex-seed to include it.",
	);
	expect(withSeedPlan[2].action).toContain(
		"Runner seed INITIAL_CHATGPT_AUTH_JSON is available and will be included for first-run sandbox-codex setup.",
	);
});
