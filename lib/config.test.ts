import { expect, test } from "vitest";
import {
	normalizeProjectConfig,
	RhapsodyConfigError,
	type RhapsodyProjectConfig,
	type RhapsodyRunner,
} from "./config";

const baseProjectConfig: Omit<RhapsodyProjectConfig, "runner"> = {
	tracker: {
		kind: "github_project",
		owner: "toyamarinyon",
		repository: "rhapsody",
		projectNumber: 4,
		statusField: "Status",
		activeStatuses: ["Todo", "In Progress"],
		terminalStatuses: ["Done"],
	},
	repository: {
		owner: "toyamarinyon",
		name: "rhapsody",
		defaultBranch: "main",
		branchPrefix: "rhapsody/",
	},
	scheduler: {
		maxConcurrentRuns: 1,
		maxConcurrentRunsByStatus: {},
		maxRetryBackoffMs: 300_000,
	},
};

type RunnerCase = {
	runner: {
		kind: RhapsodyRunner;
		timeoutMs: number;
		sandboxTimeoutBufferMs?: number;
		claimTtlBufferMs?: number;
		runningAttemptTimeoutBufferMs?: number;
		progressIntervalMs?: number;
		progressPreviewLength?: number;
		outputPreviewLength?: number;
	};
};

const invalidRunnerCases: Array<RunnerCase & { name: string }> = [
	{
		name: "non-positive runner timeout",
		runner: { kind: "sandbox-codex", timeoutMs: 0 },
	},
	{
		name: "non-positive buffer override",
		runner: {
			kind: "sandbox-codex",
			timeoutMs: 10_000,
			sandboxTimeoutBufferMs: -1,
		},
	},
	{
		name: "non-positive progress interval",
		runner: { kind: "sandbox-codex", timeoutMs: 10_000, progressIntervalMs: 0 },
	},
	{
		name: "non-positive output preview length",
		runner: {
			kind: "sandbox-codex",
			timeoutMs: 10_000,
			outputPreviewLength: 0,
		},
	},
];

test("runner timeout defaults derive derived timeouts", () => {
	const config = normalizeProjectConfig({
		...baseProjectConfig,
		runner: {
			kind: "sandbox-codex",
			timeoutMs: 25_000,
		},
	});

	expect(config.runner.sandboxTimeoutMs).toBe(25_000 + 5 * 60 * 1000);
	expect(config.runner.claimTtlMs).toBe(25_000 + 8 * 60 * 1000);
	expect(config.runner.runningAttemptTimeoutMs).toBe(25_000 + 6 * 60 * 1000);
	expect(config.runner.progressIntervalMs).toBe(30_000);
	expect(config.runner.progressPreviewLength).toBe(1000);
	expect(config.runner.outputPreviewLength).toBe(1000);
});

test("runner timeout flat buffer overrides are honored", () => {
	const config = normalizeProjectConfig({
		...baseProjectConfig,
		runner: {
			kind: "sandbox-codex",
			timeoutMs: 25_000,
			sandboxTimeoutBufferMs: 12_000,
			claimTtlBufferMs: 7_000,
			runningAttemptTimeoutBufferMs: 9_000,
			progressIntervalMs: 5_000,
			progressPreviewLength: 3_000,
			outputPreviewLength: 4_000,
		},
	});

	expect(config.runner.sandboxTimeoutMs).toBe(25_000 + 12_000);
	expect(config.runner.claimTtlMs).toBe(25_000 + 7_000);
	expect(config.runner.runningAttemptTimeoutMs).toBe(25_000 + 9_000);
	expect(config.runner.progressIntervalMs).toBe(5_000);
	expect(config.runner.progressPreviewLength).toBe(3_000);
	expect(config.runner.outputPreviewLength).toBe(4_000);
});

test.each(invalidRunnerCases)("invalid runner config is rejected: $name", ({
	runner,
}) => {
	expect(() =>
		normalizeProjectConfig({
			...baseProjectConfig,
			runner,
		}),
	).toThrow(RhapsodyConfigError);
});
