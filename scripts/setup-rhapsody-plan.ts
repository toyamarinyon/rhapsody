type SetupPhase = {
	id: string;
	command: string;
	mode: "read-only" | "dry-run-first" | "operator-controlled";
	writes: string[];
	requiresUser: string[];
	purpose: string;
};

type SetupPlanReport = {
	ok: true;
	phase: "plan";
	phases: SetupPhase[];
	recommendedNextCommand: string;
	nextActions: string[];
};

const phases: SetupPhase[] = [
	{
		id: "plan",
		command: "pnpm setup:plan",
		mode: "read-only",
		writes: [],
		requiresUser: [],
		purpose: "Print the first-run setup map and recommended next command.",
	},
	{
		id: "status",
		command: "pnpm setup:status",
		mode: "read-only",
		writes: [],
		requiresUser: [],
		purpose:
			"Read local setup progress without calling network CLIs or printing secret values.",
	},
	{
		id: "inspect",
		command: "pnpm setup:inspect",
		mode: "read-only",
		writes: [],
		requiresUser: [],
		purpose:
			"Check local CLI availability, authentication, and Git repository context.",
	},
	{
		id: "configure-local",
		command: "pnpm setup:configure-local -- --dry-run",
		mode: "dry-run-first",
		writes: [".env.local", "rhapsody.config.ts", ".rhapsody/*"],
		requiresUser: ["Apply confirmation before local file writes."],
		purpose:
			"Prepare local configuration, generated secrets, and repository-owned Rhapsody files.",
	},
	{
		id: "configure-github",
		command: "pnpm setup:configure-github -- --dry-run",
		mode: "dry-run-first",
		writes: ["GitHub ProjectV2 fields or items when apply flags request it."],
		requiresUser: [
			"GitHub authentication",
			"Apply confirmation before GitHub mutations.",
		],
		purpose:
			"Resolve or create the GitHub ProjectV2 board shape used as the work queue.",
	},
	{
		id: "configure-deploy",
		command: "pnpm setup:configure-deploy -- --dry-run",
		mode: "dry-run-first",
		writes: ["Vercel environment variables when apply flags request it."],
		requiresUser: [
			"Turso/libSQL values",
			"Vercel authentication",
			"Apply confirmation before remote env writes.",
		],
		purpose:
			"Prepare deploy-time environment variables without exposing secret values.",
	},
	{
		id: "deploy-preview",
		command: "pnpm setup:deploy-preview -- --dry-run",
		mode: "dry-run-first",
		writes: [
			"Database migrations and Vercel preview deployment when apply flags request it.",
		],
		requiresUser: ["Apply confirmation before migration or deployment."],
		purpose: "Verify deploy readiness, then create a preview deployment.",
	},
	{
		id: "smoke-test",
		command:
			"pnpm setup:smoke-test -- --url <https://your-preview-url.vercel.app>",
		mode: "read-only",
		writes: [],
		requiresUser: ["Preview deployment URL"],
		purpose: "Check preview reachability and API/dashboard readiness.",
	},
	{
		id: "seed-codex",
		command:
			"pnpm setup:seed-codex -- --url <https://your-preview-url.vercel.app>",
		mode: "dry-run-first",
		writes: ["Deployed Codex credential store when apply flags request it."],
		requiresUser: [
			"Preview deployment URL",
			"ROOT_PASSWORD opt-in",
			"Apply confirmation before credential seed.",
		],
		purpose:
			"Seed deployed Codex credentials through the trusted server-side endpoint.",
	},
	{
		id: "create-first-issue",
		command: 'pnpm setup:create-first-issue -- --title "Rhapsody smoke test"',
		mode: "dry-run-first",
		writes: ["GitHub issue and ProjectV2 item when apply flags request it."],
		requiresUser: ["Apply confirmation before GitHub mutations."],
		purpose:
			"Create the first smoke-test issue and add it to the configured project.",
	},
	{
		id: "first-issue",
		command:
			"pnpm setup:first-issue -- --url <https://your-preview-url.vercel.app> --issue-number <issueNumber>",
		mode: "dry-run-first",
		writes: ["Rhapsody run state when apply flags request it."],
		requiresUser: [
			"Preview deployment URL",
			"Issue number",
			"ROOT_PASSWORD opt-in",
			"Apply confirmation before handoff.",
		],
		purpose:
			"Hand the first issue to the deployed Rhapsody app as a manual run.",
	},
	{
		id: "first-attempt-start",
		command:
			"pnpm setup:start-attempt -- --url <https://your-preview-url.vercel.app> --run-id <runId> --attempt-id <attemptId>",
		mode: "dry-run-first",
		writes: ["Rhapsody runner attempt state when apply flags request it."],
		requiresUser: [
			"Preview deployment URL",
			"Run and attempt IDs",
			"ROOT_PASSWORD opt-in",
			"Apply confirmation before starting the attempt.",
		],
		purpose: "Start the first runner attempt for the manual run.",
	},
	{
		id: "verify-run",
		command:
			"pnpm setup:verify-run -- --url <https://your-preview-url.vercel.app> --run-id <runId>",
		mode: "read-only",
		writes: [],
		requiresUser: ["Preview deployment URL", "Run ID"],
		purpose:
			"Read run evidence and confirm whether the first issue produced branch or pull-request handoff signals.",
	},
];

const report: SetupPlanReport = {
	ok: true,
	phase: "plan",
	phases,
	recommendedNextCommand: "pnpm setup:status",
	nextActions: [
		"Run pnpm setup:status to check local setup progress without network calls.",
		"Then run pnpm setup:inspect to check local tools, authentication, and repository context.",
	],
};

console.log(JSON.stringify(report, null, 2));
