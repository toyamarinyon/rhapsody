import type { RhapsodyProjectConfig } from "./lib/config";

export default {
	tracker: {
		kind: "github_project",
		owner: "toyamarinyon",
		repository: "rhapsody",
		projectNumber: 4,
		statusField: "Status",
		activeStatuses: ["Todo", "In Progress"],
		terminalStatuses: ["Done", "Canceled", "Cancelled", "Duplicate"],
	},
	repository: {
		owner: "toyamarinyon",
		name: "rhapsody",
		defaultBranch: "main",
		branchPrefix: "rhapsody/",
	},
	scheduler: {
		maxConcurrentRuns: 3,
		maxConcurrentRunsByStatus: {},
		claimTtlMs: 18 * 60 * 1000,
		maxRetryBackoffMs: 300000,
		runningAttemptTimeoutMs: 16 * 60 * 1000,
	},
	runner: "sandbox-codex",
} satisfies RhapsodyProjectConfig;
