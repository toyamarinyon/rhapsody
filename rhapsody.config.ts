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
		claimTtlMs: 900000,
		maxRetryBackoffMs: 300000,
	},
	runner: "sandbox-codex",
} satisfies RhapsodyProjectConfig;
