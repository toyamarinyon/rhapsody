import { expect, test } from "vitest";
import {
	buildConfigureDeployBlockedNextActions,
	buildPlannedChanges,
	buildConfigureDeployUnsupportedNextActions,
	getConfigureDeployWriteKeys,
	parseConfigureDeployArgs,
	summarizeVercelAuth,
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

test("builds concrete unsupported-args next actions", () => {
	expect(buildConfigureDeployUnsupportedNextActions()).toEqual([
		"Run `pnpm setup:configure-deploy -- --dry-run` to inspect deploy environment readiness.",
		"Run `pnpm setup:configure-deploy -- --apply --yes` only after the dry-run blockers are resolved.",
	]);
});

test("summarizes Vercel auth timeouts with operator recovery", () => {
	expect(
		summarizeVercelAuth({
			status: null,
			signal: "SIGTERM",
			output: [],
			pid: 123,
			stdout: "",
			stderr: "",
			error: Object.assign(new Error("spawnSync vercel ETIMEDOUT"), {
				code: "ETIMEDOUT",
			}),
		}),
	).toBe(
		"vercel whoami timed out after 12000ms; provide VERCEL_TOKEN, run `vercel login`, or rerun when the CLI is responsive",
	);
});

test("builds concrete blocked next actions for missing deploy prerequisites", () => {
	expect(
		buildConfigureDeployBlockedNextActions({
			blocked: ["Vercel auth is not available."],
			authOk: false,
			runtimeRequiredMissing: ["CRON_SECRET", "VERCEL_TOKEN"],
			needsUser: [
				"Missing generated local secrets; run `pnpm setup:configure-local -- --apply --yes` first if you want those values populated locally.",
				"Provide VERCEL_TOKEN before any deploy apply step.",
			],
			mode: "dry-run",
		}),
	).toEqual([
		"Create a Vercel API token as VERCEL_TOKEN or run `vercel login`, then rerun `pnpm setup:configure-deploy -- --dry-run`.",
		"Run `pnpm setup:configure-local -- --apply --yes` to write missing generated local secrets, then rerun `pnpm setup:configure-deploy -- --dry-run`.",
		"Provide VERCEL_TOKEN or authenticate the Vercel CLI before applying remote env.",
		"Cannot apply required runtime Vercel env keys until all sourceable values exist: CRON_SECRET, VERCEL_TOKEN.",
		"Collect the missing operator-provided values, then rerun `pnpm setup:configure-deploy -- --dry-run`.",
	]);
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
