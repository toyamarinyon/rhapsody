import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Check = {
	name: string;
	ok: boolean;
	detail: string;
};

type Facts = {
	input: {
		providedTitle: string | null;
		providedBody: string | null;
		resolvedTitle: string;
		resolvedBody: string;
		applyRequested: boolean;
		yesFlagPresent: boolean;
	};
	cli: {
		gh: {
			available: boolean;
			version: string | null;
		};
		auth: {
			ok: boolean;
			summary: string;
		};
	};
	repo: {
		owner: string | null;
		repository: string | null;
		nameWithOwner: string | null;
	};
	config: {
		path: string;
		exists: boolean;
		projectNumber: number | null;
		projectOwner: string | null;
		projectRepository: string | null;
	};
	issue: {
		title: string;
		body: string;
		number: number | null;
		url: string | null;
		addToProjectResult: {
			attempted: boolean;
			success: boolean | null;
			summary: string | null;
			projectItemId: string | null;
		};
	};
};

type Report = {
	ok: boolean;
	mode: "dry-run" | "apply";
	phase: "create-first-issue";
	facts: Facts;
	checks: Check[];
	plannedChanges: Array<{
		kind: string;
		target: string;
		action: string;
		reason: string;
		requiresUserConfirmation: boolean;
		wouldWrite: boolean;
	}>;
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
	error?: string;
};

type ParsedArgs = {
	mode: "dry-run" | "apply";
	title: string | null;
	body: string | null;
};

export type ParsedIssueCreateOutput = {
	issueUrl: string;
	issueNumber: number;
};

type ParsedIssueCreateOutputError =
	| { ok: true; issueUrl: string; issueNumber: number }
	| { ok: false; error: string };

const DEFAULT_TITLE = "Rhapsody smoke-test issue";
const DEFAULT_BODY =
	"Smoke test issue created by setup:create-first-issue for first-run handoff validation.";
const REQUEST_TIMEOUT_MS = 12_000;

function emit(report: Report, exitCode = 0) {
	process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
	process.exitCode = exitCode;
}

function normalizeFlags(argv: string[]) {
	const flags = argv.slice(2);
	return flags.length > 0 && flags[0] === "--" ? flags.slice(1) : flags;
}

export function parseArgs(argv: string[]): ParsedArgs | null {
	const args = normalizeFlags(argv);
	let mode: "dry-run" | "apply" = "dry-run";
	let hasApply = false;
	let hasYes = false;
	let title: string | null = null;
	let body: string | null = null;

	let index = 0;
	while (index < args.length) {
		const arg = args[index];
		if (arg === "--dry-run") {
			index += 1;
			continue;
		}

		if (arg === "--apply") {
			hasApply = true;
			index += 1;
			continue;
		}

		if (arg === "--yes") {
			hasYes = true;
			index += 1;
			continue;
		}

		if (arg.startsWith("--title=")) {
			title = arg.slice("--title=".length);
			index += 1;
			continue;
		}

		if (arg === "--title") {
			const value = args[index + 1];
			if (!value) {
				return null;
			}
			title = value;
			index += 2;
			continue;
		}

		if (arg.startsWith("--body=")) {
			body = arg.slice("--body=".length);
			index += 1;
			continue;
		}

		if (arg === "--body") {
			const value = args[index + 1];
			if (!value) {
				return null;
			}
			body = value;
			index += 2;
			continue;
		}

		return null;
	}

	if (hasApply !== hasYes) {
		return null;
	}

	if (hasApply) {
		mode = "apply";
	}

	return { mode, title, body };
}

export function parseIssueCreateUrl(
	stdout: string,
): ParsedIssueCreateOutputError {
	const url = stdout
		.trim()
		.split(/\r?\n/)
		.find((line) => {
			return /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+/.test(line);
		});
	if (!url) {
		return {
			ok: false,
			error: "gh issue create did not print a parseable issue URL",
		};
	}

	const numberMatch = url.match(/\/issues\/(\d+)(?:$|[/?#])/);
	const issueNumber = numberMatch?.[1]
		? Number.parseInt(numberMatch[1], 10)
		: null;
	if (!issueNumber || !Number.isInteger(issueNumber)) {
		return {
			ok: false,
			error: "gh issue create did not print a parseable issue URL",
		};
	}

	return { ok: true, issueUrl: url, issueNumber };
}

function parseProjectNumberFromConfig(content: string): number | null {
	const match = content.match(/projectNumber\s*:\s*(\d+)/);
	if (!match?.[1]) {
		return null;
	}
	const projectNumber = Number.parseInt(match[1], 10);
	return Number.isInteger(projectNumber) && projectNumber > 0
		? projectNumber
		: null;
}

function parseProjectOwnerFromConfig(content: string): string | null {
	const tracker = extractTrackerBlock(content);
	if (!tracker) {
		return null;
	}
	const match = tracker.match(/owner\s*:\s*["'`]([^"'`]+)["'`]/);
	return match?.[1] ?? null;
}

function parseProjectRepositoryFromConfig(content: string): string | null {
	const tracker = extractTrackerBlock(content);
	if (!tracker) {
		return null;
	}
	const match = tracker.match(/repository\s*:\s*["'`]([^"'`]+)["'`]/);
	return match?.[1] ?? null;
}

function extractTrackerBlock(content: string): string | null {
	const trackerMatch = content.match(/(^|\n)([ \t]*)tracker\s*:\s*\{/m);
	if (!trackerMatch) {
		return null;
	}

	const openBraceIndex =
		(trackerMatch.index || 0) + trackerMatch[0].indexOf("{");
	let depth = 0;
	let inString: "'" | '"' | "`" | null = null;
	let escaped = false;

	for (let index = openBraceIndex; index < content.length; index += 1) {
		const char = content[index];

		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === inString) {
				inString = null;
			}
			continue;
		}

		if (char === "'" || char === '"' || char === "`") {
			inString = char;
			continue;
		}

		if (char === "{") {
			depth += 1;
			continue;
		}

		if (char === "}") {
			depth -= 1;
			if (depth === 0) {
				return content.slice(openBraceIndex + 1, index);
			}
		}
	}

	return null;
}

function run(command: string, args: string[]) {
	return spawnSync(command, args, {
		encoding: "utf8",
		timeout: REQUEST_TIMEOUT_MS,
		env: buildCommandEnv(command),
	});
}

function readEnvLocalValue(key: string) {
	if (!existsSync(".env.local")) {
		return "";
	}
	const content = readFileSync(".env.local", "utf8");
	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const entry = line.startsWith("export ") ? line.slice(7).trim() : line;
		const equalsIndex = entry.indexOf("=");
		if (equalsIndex <= 0) {
			continue;
		}
		const parsedKey = entry.slice(0, equalsIndex).trim();
		const parsedValue = entry.slice(equalsIndex + 1).trim();
		if (parsedKey === key && parsedValue) {
			return parsedValue;
		}
	}
	return "";
}

export function buildCommandEnv(command: string) {
	if (command !== "gh" || process.env.GH_TOKEN?.trim()) {
		return process.env;
	}

	const githubToken =
		process.env.GITHUB_TOKEN?.trim() || readEnvLocalValue("GITHUB_TOKEN");
	if (!githubToken) {
		return process.env;
	}

	return {
		...process.env,
		GH_TOKEN: githubToken,
	};
}

function hasGithubTokenForGh() {
	return Boolean(
		process.env.GH_TOKEN?.trim() ||
			process.env.GITHUB_TOKEN?.trim() ||
			readEnvLocalValue("GITHUB_TOKEN"),
	);
}

function summarizeCommandResult(result: ReturnType<typeof run>) {
	if (result.status === 0) {
		return "ok";
	}
	return (
		(result.stderr || result.stdout || result.error?.message || "").trim() ||
		"command failed"
	);
}

function checkCommandAvailability(
	command: string,
	args: string[] = ["--version"],
) {
	const result = run(command, args);
	return {
		available: result.status === 0,
		version:
			result.status === 0
				? ((result.stdout || result.stderr).trim().split("\n")[0] ?? null)
				: null,
	};
}

function parseRemote(rawUrl: string | null) {
	if (!rawUrl) return null;
	const httpsMatch = rawUrl.match(
		/^https:\/\/(?:[^@]+@)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
	);
	const sshMatch = rawUrl.match(
		/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
	);
	const match = httpsMatch ?? sshMatch;
	if (!match) return null;
	return {
		owner: match[1] ?? null,
		repository: match[2] ?? null,
	};
}

function readRepoRemote() {
	const result = run("git", ["remote", "get-url", "origin"]);
	if (result.status !== 0) {
		return null;
	}
	return parseRemote(result.stdout.trim());
}

function ghAuthSummary(result: ReturnType<typeof run>) {
	if (result.status === 0) {
		return "authenticated";
	}
	const output = (result.stderr || result.stdout || "").trim();
	if (!output) {
		return `unauthenticated (exit ${result.status})`;
	}
	return output.split("\n")[0] ?? output;
}

function readGhAuthStatus() {
	if (hasGithubTokenForGh()) {
		const result = run("gh", ["api", "user", "--jq", ".login"]);
		return {
			ok: result.status === 0,
			summary:
				result.status === 0 ? "GITHUB_TOKEN valid" : ghAuthSummary(result),
		};
	}

	const result = run("gh", ["auth", "status"]);
	return {
		ok: result.status === 0,
		summary: ghAuthSummary(result),
	};
}

function readLocalConfig() {
	const configPath = `${process.cwd()}/rhapsody.config.ts`;
	if (!existsSync(configPath)) {
		return {
			exists: false,
			projectNumber: null as number | null,
			owner: null as string | null,
			repository: null as string | null,
		};
	}
	const content = readFileSync(configPath, "utf8");
	return {
		exists: true,
		projectNumber: parseProjectNumberFromConfig(content),
		owner: parseProjectOwnerFromConfig(content),
		repository: parseProjectRepositoryFromConfig(content),
	};
}

function readRepoView(owner: string, repository: string) {
	const result = run("gh", [
		"repo",
		"view",
		`${owner}/${repository}`,
		"--json",
		"nameWithOwner",
	]);
	if (result.status !== 0) {
		return {
			accessible: false,
			nameWithOwner: null as string | null,
			error: summarizeCommandResult(result),
		};
	}
	try {
		const parsed = JSON.parse(result.stdout) as {
			nameWithOwner?: string;
		};
		return {
			accessible: true,
			nameWithOwner: parsed.nameWithOwner ?? `${owner}/${repository}`,
			error: null as string | null,
		};
	} catch (error) {
		return {
			accessible: false,
			nameWithOwner: null as string | null,
			error:
				error instanceof Error
					? error.message
					: "invalid JSON from gh repo view",
		};
	}
}

function createIssue(args: {
	owner: string;
	repository: string;
	title: string;
	body: string;
}) {
	const result = run("gh", [
		"issue",
		"create",
		"--repo",
		`${args.owner}/${args.repository}`,
		"--title",
		args.title,
		"--body",
		args.body,
	]);
	if (result.status !== 0) {
		return {
			ok: false as const,
			number: null as number | null,
			url: null as string | null,
			error: summarizeCommandResult(result),
		};
	}

	const parsedIssue = parseIssueCreateUrl(result.stdout);
	if (!parsedIssue.ok) {
		return {
			ok: false as const,
			number: null,
			url: null,
			error: parsedIssue.error,
		};
	}

	return {
		ok: true as const,
		number: parsedIssue.issueNumber,
		url: parsedIssue.issueUrl,
		error: null as string | null,
	};
}

function addIssueToProject(args: {
	projectNumber: number;
	owner: string;
	issueUrl: string;
}) {
	const result = run("gh", [
		"project",
		"item-add",
		String(args.projectNumber),
		"--owner",
		args.owner,
		"--url",
		args.issueUrl,
		"--format",
		"json",
	]);
	if (result.status !== 0) {
		return {
			ok: false as const,
			itemId: null as string | null,
			error: summarizeCommandResult(result),
		};
	}
	try {
		const parsed = JSON.parse(result.stdout) as {
			id?: string;
			items?: Array<{ id?: string }>;
		};
		return {
			ok: true as const,
			itemId:
				parsed.id ??
				(parsed.items?.[0]?.id ? (parsed.items?.[0]?.id ?? null) : null),
			error: null as string | null,
		};
	} catch {
		return {
			ok: true as const,
			itemId: null as string | null,
			error: null as string | null,
		};
	}
}

function makeBaseFacts(args: {
	mode: "dry-run" | "apply";
	title: string | null;
	body: string | null;
	config: ReturnType<typeof readLocalConfig>;
	repoOwner: string | null;
	repoRepository: string | null;
	gh: { available: boolean; version: string | null };
	ghAuth: { ok: boolean; summary: string };
	repoView: ReturnType<typeof readRepoView>;
}) {
	return {
		input: {
			providedTitle: args.title,
			providedBody: args.body,
			resolvedTitle: titleOrDefault(args.title),
			resolvedBody: bodyOrDefault(args.body),
			applyRequested: args.mode === "apply",
			yesFlagPresent: args.mode === "apply",
		},
		cli: {
			gh: {
				available: args.gh.available,
				version: args.gh.version,
			},
			auth: {
				ok: args.ghAuth.ok,
				summary: args.ghAuth.summary,
			},
		},
		repo: {
			owner: args.repoOwner,
			repository: args.repoRepository,
			nameWithOwner: args.repoView.nameWithOwner,
		},
		config: {
			path: "rhapsody.config.ts",
			exists: args.config.exists,
			projectNumber: args.config.projectNumber,
			projectOwner: args.config.owner,
			projectRepository: args.config.repository,
		},
		issue: {
			title: titleOrDefault(args.title),
			body: bodyOrDefault(args.body),
			number: null,
			url: null,
			addToProjectResult: {
				attempted: false,
				success: null,
				summary: null,
				projectItemId: null,
			},
		},
	};
}

export function buildPartialIssueProjectActions(args: {
	issueNumber: number;
	issueUrl: string;
}) {
	return {
		needsUser: [
			"Add the issue to the ProjectV2 board manually if required.",
			`Issue was created as #${args.issueNumber} at ${args.issueUrl}.`,
			`Continue with setup:first-issue using --issue-number ${args.issueNumber}.`,
		],
		blocked: [
			"The issue was created but could not be added to ProjectV2.",
			`Issue remains available for manual recovery: #${args.issueNumber} (${args.issueUrl}).`,
		],
		nextActions: [
			`Run the issue handoff manually using the existing issue number #${args.issueNumber} and URL ${args.issueUrl}.`,
			`Then run: pnpm setup:first-issue -- --url <preview-url> --issue-number ${args.issueNumber}.`,
		],
	};
}

export function buildBlockedNextActions(args: {
	ghAvailable: boolean;
	ghAuthOk: boolean;
	repoResolved: boolean;
	repoAccessible: boolean;
	configExists: boolean;
	projectNumberConfigured: boolean;
}) {
	const nextActions: string[] = [];

	if (!args.ghAvailable) {
		nextActions.push(
			"Install the GitHub CLI (`gh`), then rerun `pnpm setup:create-first-issue -- --dry-run`.",
		);
	}
	if (!args.ghAuthOk) {
		nextActions.push(
			'Refresh or replace GITHUB_TOKEN/GH_TOKEN with repository and ProjectV2 access, or run `gh auth login`, then rerun `pnpm setup:create-first-issue -- --title "Rhapsody smoke test"`.',
		);
	}
	if (!args.repoResolved) {
		nextActions.push(
			"Configure tracker.owner/repository in rhapsody.config.ts or add a valid GitHub origin remote, then rerun `pnpm setup:create-first-issue -- --dry-run`.",
		);
	}
	if (args.repoResolved && !args.repoAccessible) {
		nextActions.push(
			"Confirm the resolved repository is readable with `gh repo view <owner>/<repo>`, then rerun `pnpm setup:create-first-issue -- --dry-run`.",
		);
	}
	if (!args.configExists) {
		nextActions.push(
			"Create or restore rhapsody.config.ts before creating the smoke-test issue.",
		);
	}
	if (!args.projectNumberConfigured) {
		nextActions.push(
			"Run `pnpm setup:configure-github -- --dry-run`, then persist the ProjectV2 number with `pnpm setup:configure-local -- --apply --yes --project-number <number>`.",
		);
	}

	return [...new Set(nextActions)];
}

function buildIssueCreateFailureNextActions(args: {
	owner: string;
	repository: string;
	title: string;
	error: string | null | undefined;
}) {
	const output = String(args.error ?? "").toLowerCase();
	const nextActions = [
		`Check issue creation manually with: gh issue create --repo ${args.owner}/${args.repository} --title "${args.title}" --body "<body>".`,
	];

	if (
		output.includes("authentication") ||
		output.includes("not logged") ||
		output.includes("login")
	) {
		nextActions.unshift(
			"Refresh GitHub authentication with `gh auth login` or `gh auth refresh -s project,repo`, then rerun `pnpm setup:create-first-issue -- --apply --yes`.",
		);
	} else if (
		output.includes("not found") ||
		output.includes("could not resolve") ||
		output.includes("repository")
	) {
		nextActions.unshift(
			"Verify tracker.owner/repository or the git origin remote resolves to the intended GitHub repository.",
		);
	} else if (
		output.includes("permission") ||
		output.includes("forbidden") ||
		output.includes("resource not accessible")
	) {
		nextActions.unshift(
			"Confirm the GitHub token has permission to create issues in the target repository.",
		);
	} else {
		nextActions.unshift(
			"Inspect the gh error above, fix the issue creation precondition, then rerun `pnpm setup:create-first-issue -- --apply --yes`.",
		);
	}

	return [...new Set(nextActions)];
}

function titleOrDefault(value: string | null) {
	return value?.trim() || DEFAULT_TITLE;
}

function bodyOrDefault(value: string | null) {
	return value?.trim() || DEFAULT_BODY;
}

function buildReport(args: {
	mode: "dry-run" | "apply";
	facts: Facts;
	checks: Check[];
	needsUser: string[];
	blocked: string[];
	nextActions: string[];
	plannedChanges: Array<{
		kind: string;
		target: string;
		action: string;
		reason: string;
		requiresUserConfirmation: boolean;
		wouldWrite: boolean;
	}>;
}) {
	return {
		ok: args.blocked.length === 0,
		mode: args.mode,
		phase: "create-first-issue" as const,
		facts: args.facts,
		checks: args.checks,
		plannedChanges: args.plannedChanges,
		needsUser: args.needsUser,
		blocked: args.blocked,
		nextActions: args.nextActions,
	};
}

export function buildUnsupportedArgsReport(message: string): Report {
	return {
		ok: false,
		mode: "dry-run",
		phase: "create-first-issue",
		facts: {
			input: {
				providedTitle: null,
				providedBody: null,
				resolvedTitle: DEFAULT_TITLE,
				resolvedBody: DEFAULT_BODY,
				applyRequested: false,
				yesFlagPresent: false,
			},
			cli: {
				gh: { available: false, version: null },
				auth: { ok: false, summary: "unsupported arguments" },
			},
			repo: {
				owner: null,
				repository: null,
				nameWithOwner: null,
			},
			config: {
				path: "rhapsody.config.ts",
				exists: existsSync("rhapsody.config.ts"),
				projectNumber: null,
				projectOwner: null,
				projectRepository: null,
			},
			issue: {
				title: DEFAULT_TITLE,
				body: DEFAULT_BODY,
				number: null,
				url: null,
				addToProjectResult: {
					attempted: false,
					success: null,
					summary: null,
					projectItemId: null,
				},
			},
		},
		checks: [],
		plannedChanges: [],
		needsUser: [
			"Use --title <title>, optional --body <body>, optional --apply --yes to run.",
		],
		blocked: ["Unsupported or missing arguments."],
		nextActions: [
			'Run "pnpm setup:create-first-issue -- --title <title> --body <body>" for a dry-run check.',
			'Run "pnpm setup:create-first-issue -- --apply --yes --title <title>" to create an issue.',
		],
		error: message,
	};
}

function unsupportedArgsError(message: string) {
	emit(buildUnsupportedArgsReport(message), 1);
}

function resolveRepositoryConfig(args: {
	local: ReturnType<typeof readLocalConfig>;
	remote: ReturnType<typeof readRepoRemote>;
}) {
	const owner = args.local.owner ?? args.remote?.owner ?? null;
	const repository = args.local.repository ?? args.remote?.repository ?? null;
	return {
		owner,
		repository,
	};
}

async function main() {
	const parsed = parseArgs(process.argv);
	if (!parsed) {
		unsupportedArgsError("Unsupported arguments.");
		return;
	}

	const config = readLocalConfig();
	const remote = readRepoRemote();
	const resolvedRepo = resolveRepositoryConfig({ local: config, remote });
	const gh = checkCommandAvailability("gh", ["--version"]);
	const ghAuth = gh.available
		? readGhAuthStatus()
		: { ok: false, summary: "gh is not available" };
	const repoView =
		resolvedRepo.owner && resolvedRepo.repository && ghAuth.ok
			? readRepoView(resolvedRepo.owner, resolvedRepo.repository)
			: {
					accessible: false,
					nameWithOwner: null,
					error: !gh.available
						? "gh is not available"
						: !ghAuth.ok
							? "gh authentication required"
							: !resolvedRepo.owner || !resolvedRepo.repository
								? "repository could not be resolved from local config or git remote"
								: "repo view skipped",
				};

	const checks: Check[] = [
		{
			name: "gh-cli",
			ok: gh.available,
			detail: gh.available
				? `gh available${gh.version ? ` (${gh.version})` : ""}`
				: "gh unavailable",
		},
		{
			name: "gh-auth",
			ok: ghAuth.ok,
			detail: ghAuth.summary,
		},
		{
			name: "repo-resolution",
			ok: Boolean(resolvedRepo.owner && resolvedRepo.repository),
			detail:
				resolvedRepo.owner && resolvedRepo.repository
					? `${resolvedRepo.owner}/${resolvedRepo.repository}`
					: "owner/repository not resolved",
		},
		{
			name: "repo-access",
			ok: repoView.accessible,
			detail: repoView.accessible
				? `${repoView.nameWithOwner}`
				: (repoView.error ?? "repo view unavailable"),
		},
		{
			name: "tracker-project-number",
			ok: typeof config.projectNumber === "number",
			detail:
				typeof config.projectNumber === "number"
					? `projectNumber ${config.projectNumber}`
					: "tracker.projectNumber is missing",
		},
	];

	const facts: Facts = makeBaseFacts({
		mode: parsed.mode,
		title: parsed.title,
		body: parsed.body,
		config,
		repoOwner: resolvedRepo.owner,
		repoRepository: resolvedRepo.repository,
		gh,
		ghAuth,
		repoView,
	});

	const needsUser: string[] = [];
	const blocked: string[] = [];

	if (!gh.available) blocked.push("gh CLI is unavailable.");
	if (!gh.available) {
		needsUser.push("Install the GitHub CLI (`gh`) before creating issues.");
	}
	if (!ghAuth.ok) {
		blocked.push("Authenticate gh with `gh auth login`.");
		needsUser.push(
			'Refresh or replace GITHUB_TOKEN/GH_TOKEN with repository and ProjectV2 access, or run `gh auth login`, then rerun `pnpm setup:create-first-issue -- --title "Rhapsody smoke test"`.',
		);
	}
	if (!resolvedRepo.owner || !resolvedRepo.repository) {
		blocked.push(
			"Resolve repository owner/repository from local config or git remote before apply.",
		);
		needsUser.push(
			"Configure tracker.owner/repository in rhapsody.config.ts or add a valid origin remote.",
		);
	}
	if (!repoView.accessible) {
		blocked.push("Repository access is required before creating issues.");
	}
	if (!config.exists) {
		blocked.push(
			"rhapsody.config.ts is required to identify tracker.projectNumber.",
		);
		needsUser.push(
			"Create or restore rhapsody.config.ts in the repository root.",
		);
	}
	if (typeof config.projectNumber !== "number") {
		blocked.push("tracker.projectNumber must be set in rhapsody.config.ts.");
		needsUser.push(
			"Run setup:configure-github and set tracker.projectNumber before this helper applies.",
		);
	}

	const projectOwner = resolvedRepo.owner ?? config.owner ?? null;
	if (!projectOwner) {
		emit(
			{
				...buildReport({
					mode: parsed.mode,
					facts,
					checks,
					needsUser: [
						"Project owner could not be resolved from local config or repository owner.",
					],
					blocked: [...blocked, "Project owner could not be resolved."],
					nextActions: [
						"Resolve tracker owner from local config or git remote before rerunning.",
					],
					plannedChanges: [
						{
							kind: "github-issue-create",
							target: "GitHub ProjectV2",
							action:
								"Create a smoke-test issue and attach it to the configured ProjectV2.",
							reason: "Apply requires a resolved ProjectV2 owner.",
							requiresUserConfirmation: true,
							wouldWrite: true,
						},
					],
				}),
				ok: false,
			},
			1,
		);
		return;
	}

	if (parsed.mode === "dry-run") {
		emit(
			buildReport({
				mode: "dry-run",
				facts,
				checks,
				needsUser,
				blocked: blocked,
				nextActions:
					blocked.length > 0
						? buildBlockedNextActions({
								ghAvailable: gh.available,
								ghAuthOk: ghAuth.ok,
								repoResolved: Boolean(
									resolvedRepo.owner && resolvedRepo.repository,
								),
								repoAccessible: repoView.accessible,
								configExists: config.exists,
								projectNumberConfigured:
									typeof config.projectNumber === "number",
							})
						: [
								"Run with --apply --yes to create and queue the issue.",
								"Current defaults can be overridden with --title and --body.",
							],
				plannedChanges: [
					{
						kind: "github-issue-create",
						target: `${resolvedRepo.owner ?? "<owner>"}/${resolvedRepo.repository ?? "<repo>"}`,
						action:
							"Create one issue and add its URL to ProjectV2 via gh project item-add.",
						reason:
							"This dry-run is read-only. It validates preconditions for issue creation and project attachment.",
						requiresUserConfirmation: true,
						wouldWrite: false,
					},
				],
			}),
		);
		return;
	}

	if (!ghAuth.ok) {
		emit(
			{
				...buildReport({
					mode: "apply",
					facts,
					checks,
					needsUser,
					blocked,
					nextActions: [
						'Refresh or replace GITHUB_TOKEN/GH_TOKEN with repository and ProjectV2 access, or run `gh auth login`, then rerun `pnpm setup:create-first-issue -- --apply --yes --title "Rhapsody smoke test"`.',
					],
					plannedChanges: [
						{
							kind: "github-issue-create",
							target: `${resolvedRepo.owner ?? "<owner>"}/${resolvedRepo.repository ?? "<repo>"}`,
							action:
								"Create one issue and add it to the configured ProjectV2.",
							reason:
								"Apply requires gh authentication and configured repository/project context.",
							requiresUserConfirmation: true,
							wouldWrite: true,
						},
					],
				}),
				ok: false,
			},
			1,
		);
		return;
	}

	if (blocked.length > 0) {
		emit(
			{
				...buildReport({
					mode: "apply",
					facts,
					checks,
					needsUser,
					blocked,
					nextActions: [
						"Resolve the blocked requirements and rerun with --apply --yes.",
					],
					plannedChanges: [
						{
							kind: "github-issue-create",
							target: `${resolvedRepo.owner ?? "<owner>"}/${resolvedRepo.repository ?? "<repo>"}`,
							action:
								"Create one issue and add it to the configured ProjectV2.",
							reason:
								"Apply is blocked until repository/project prerequisites pass.",
							requiresUserConfirmation: true,
							wouldWrite: true,
						},
					],
				}),
				ok: false,
			},
			1,
		);
		return;
	}

	const issue = createIssue({
		owner: resolvedRepo.owner!,
		repository: resolvedRepo.repository!,
		title: facts.issue.title,
		body: facts.issue.body,
	});

	facts.issue.number = issue.number;
	facts.issue.url = issue.url;

	if (!issue.ok) {
		emit(
			buildReport({
				mode: "apply",
				facts,
				checks,
				needsUser: [
					...needsUser,
					"Re-run only after fixing gh issue creation environment.",
				],
				blocked: [...blocked, issue.error ?? "Issue creation failed."],
				nextActions: buildIssueCreateFailureNextActions({
					owner: resolvedRepo.owner!,
					repository: resolvedRepo.repository!,
					title: facts.issue.title,
					error: issue.error,
				}),
				plannedChanges: [
					{
						kind: "github-issue-create",
						target: `${resolvedRepo.owner}/${resolvedRepo.repository}`,
						action: "Create smoke-test issue.",
						reason: "Apply creates a real GitHub issue.",
						requiresUserConfirmation: true,
						wouldWrite: true,
					},
					{
						kind: "project-item-add",
						target: `ProjectV2 #${config.projectNumber}`,
						action: "Add the issue URL to the configured board.",
						reason: "Run this after successful issue creation.",
						requiresUserConfirmation: true,
						wouldWrite: false,
					},
				],
			}),
			1,
		);
		return;
	}

	const projectItemAdd = addIssueToProject({
		projectNumber: config.projectNumber!,
		owner: projectOwner,
		issueUrl: issue.url!,
	});

	facts.issue.addToProjectResult = {
		attempted: true,
		success: projectItemAdd.ok,
		summary: projectItemAdd.error ?? (projectItemAdd.ok ? "added" : null),
		projectItemId: projectItemAdd.itemId,
	};

	const partialSuccess = issue.ok && !projectItemAdd.ok;

	const finalNeedsUser = partialSuccess
		? buildPartialIssueProjectActions({
				issueNumber: issue.number!,
				issueUrl: issue.url!,
			}).needsUser
		: [];
	const finalBlocked = partialSuccess
		? buildPartialIssueProjectActions({
				issueNumber: issue.number!,
				issueUrl: issue.url!,
			}).blocked
		: [];
	const finalNextActions = partialSuccess
		? buildPartialIssueProjectActions({
				issueNumber: issue.number!,
				issueUrl: issue.url!,
			}).nextActions
		: [
				`Next action: pnpm setup:first-issue -- --url <preview-url> --issue-number ${issue.number}.`,
			];

	emit(
		{
			...buildReport({
				mode: "apply",
				facts,
				checks,
				needsUser: finalNeedsUser,
				blocked: finalBlocked,
				nextActions: finalNextActions,
				plannedChanges: [
					{
						kind: "github-issue-create",
						target: `${resolvedRepo.owner}/${resolvedRepo.repository}`,
						action: "Created issue and attached to ProjectV2.",
						reason:
							"Apply path performs the actual remote mutation for first smoke-test issue.",
						requiresUserConfirmation: true,
						wouldWrite: true,
					},
				],
			}),
			ok: partialSuccess ? false : true,
		},
		partialSuccess ? 1 : 0,
	);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
	main();
}
