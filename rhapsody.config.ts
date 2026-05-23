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
		maxRetryBackoffMs: 300000,
	},
	runner: {
		kind: "sandbox-codex",
		timeoutMs: 25 * 60 * 1000,
	},
} satisfies RhapsodyProjectConfig;
