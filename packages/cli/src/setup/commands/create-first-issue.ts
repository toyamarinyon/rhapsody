#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
	collectCreateFirstIssueGhChecks,
	getCreateFirstIssueRepository,
	parseIssueCreateCommandOutput,
} from "../github.js";
import {
	getSetupStatePath,
	recordSetupJourneyState,
	recordSetupState,
} from "../state.js";
import type {
	CommandMode,
	CreateFirstIssuePlanResult,
	CreateFirstIssueApplyResult,
	ParseSetupCreateFirstIssueResult,
	ParseSetupCreateFirstIssueSuccess,
	LegacyExitCode,
} from "../types.js";

const DEFAULT_FIRST_ISSUE_TITLE = "Rhapsody smoke-test issue";
const DEFAULT_FIRST_ISSUE_BODY =
	"Smoke test issue created by setup:create-first-issue for first-run handoff validation.";
const BODY_PREVIEW_MAX = 120;

type SyncCommandResult = {
	ok: boolean;
	stdout: string;
	stderr: string;
};

export async function runCreateFirstIssueCommand(
	args: string[],
): Promise<LegacyExitCode> {
	const parse = parseSetupCreateFirstIssueArgs(args);
	if (parse.ok === false) {
		console.error(parse.error);
		process.exit(1);
	}

	const plan = buildCreateFirstIssuePlan({
		parse: parse as ParseSetupCreateFirstIssueSuccess,
		statePath: getSetupStatePath(),
	});
	if (plan.mode === "dry-run") {
		recordSetupState({
			command: "create-first-issue",
			mode: plan.mode,
			statePath: plan.statePath,
			repository: plan.repository,
			title: plan.title,
			bodyPreview: plan.bodyPreview,
			blockers: plan.blockers,
			nextAction: plan.blockers.length ? "blocked" : "ready",
			nextActions: plan.nextActions,
		});
		printCreateFirstIssueResult({ json: parse.json, plan });
		process.exit(plan.blockers.length ? 1 : 0);
	}

	if (plan.blockers.length > 0) {
		recordSetupState({
			command: "create-first-issue",
			mode: plan.mode,
			statePath: plan.statePath,
			repository: plan.repository,
			title: plan.title,
			bodyPreview: plan.bodyPreview,
			blockers: plan.blockers,
			nextAction: "blocked",
			nextActions: plan.nextActions,
		});
		printCreateFirstIssueResult({ json: parse.json, plan });
		process.exit(1);
	}

	const apply = runCreateFirstIssueApply(plan);
	if (apply.ok && apply.issue) {
		recordSetupJourneyState({
			firstRun: {
				firstIssue: {
					number: apply.issue.number,
					url: apply.issue.url,
					source: "created",
				},
				currentStep: "create-first-issue",
				completedSteps: ["create-first-issue"],
				nextActions: [
					`Run rhapsody first-issue --url <preview-url> --issue-number ${apply.issue.number} --use-root-password.`,
				],
				lastCommand: "create-first-issue",
			},
		});
	}
	recordSetupState({
		command: "create-first-issue",
		mode: plan.mode,
		statePath: plan.statePath,
		repository: plan.repository,
		title: plan.title,
		bodyPreview: plan.bodyPreview,
		issue: apply.issue,
		blockers: apply.blockers,
		nextAction: apply.ok ? "complete" : "failed",
		nextActions: apply.nextActions,
	});
	printCreateFirstIssueResult({
		json: parse.json,
		plan: {
			...plan,
			ok: apply.ok,
			issue: apply.issue,
			blockers: apply.blockers,
			nextActions: apply.nextActions,
		},
	});
	process.exit(apply.ok ? 0 : 1);
}

function parseSetupCreateFirstIssueArgs(
	args: string[],
): ParseSetupCreateFirstIssueResult {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error:
				"Usage: rhapsody create-first-issue [--dry-run] [--json] [--title <title>] [--body <body>]\n       rhapsody create-first-issue --yes [--json] [--title <title>] [--body <body>]",
		};
	}

	let mode: CommandMode = "dry-run";
	let yes = false;
	let dryRun = false;
	let title = DEFAULT_FIRST_ISSUE_TITLE;
	let body = DEFAULT_FIRST_ISSUE_BODY;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (arg === "--yes") {
			yes = true;
			continue;
		}
		if (arg === "--json") {
			continue;
		}
		if (arg.startsWith("--title=")) {
			title = arg.slice("--title=".length);
			continue;
		}
		if (arg === "--title") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return { ok: false, error: "Missing value for --title." };
			}
			title = value;
			i += 1;
			continue;
		}
		if (arg.startsWith("--body=")) {
			body = arg.slice("--body=".length);
			continue;
		}
		if (arg === "--body") {
			const value = args[i + 1];
			if (!value || value.startsWith("--")) {
				return { ok: false, error: "Missing value for --body." };
			}
			body = value;
			i += 1;
			continue;
		}
		if (arg === "create-first-issue") {
			continue;
		}
		return { ok: false, error: `Unsupported argument: ${arg}` };
	}

	if (dryRun && yes) {
		return {
			ok: false,
			error: "Use either --dry-run or --yes, not both.",
		};
	}

	if (yes) {
		mode = "apply";
	}

	return {
		ok: true,
		mode,
		yes,
		dryRun,
		title,
		body,
		json: args.includes("--json"),
	};
}

function buildCreateFirstIssuePlan({
	parse,
	statePath,
}: {
	parse: ParseSetupCreateFirstIssueSuccess;
	statePath: string;
}): CreateFirstIssuePlanResult {
	const title = parse.title?.trim() ?? DEFAULT_FIRST_ISSUE_TITLE;
	const body = parse.body?.trim() ?? DEFAULT_FIRST_ISSUE_BODY;
	const repository = getCreateFirstIssueRepository();
	const blockers: string[] = [];
	const mode = parse.mode;
	const commandArgv = [
		"gh",
		"issue",
		"create",
		"--repo",
		repository ?? "",
		"--title",
		title,
		"--body",
		body,
	];
	const nextActions: string[] = [];
	const bodyPreview = createBodyPreview(body);
	const commandTarget = repository ?? "<owner/repo>";
	const plannedCommand = `gh issue create --repo ${commandTarget} --title ${quoteForCommandPreview(
		title,
	)} --body ${quoteForCommandPreview(bodyPreview)}`;

	if (!repository) {
		blockers.push(
			"Configure `remote.origin.url` and authenticate gh so setup can identify and access the repository.",
		);
	}
	if (!title) {
		blockers.push("Issue title must be a non-empty string.");
	}
	if (!body) {
		blockers.push("Issue body must be a non-empty string.");
	}

	const ghChecks = collectCreateFirstIssueGhChecks({ repository });
	blockers.push(...ghChecks);

	if (blockers.length > 0) {
		nextActions.push(
			"Fix blockers and rerun `rhapsody create-first-issue --dry-run`.",
		);
	} else {
		nextActions.push(
			"Run `rhapsody create-first-issue --yes` to create issue.",
		);
	}

	return {
		ok: blockers.length === 0,
		mode,
		statePath,
		repository,
		title,
		bodyPreview,
		plannedCommand,
		commandArgv,
		blockers,
		nextActions,
		issue: null,
	};
}

function runCreateFirstIssueApply(
	plan: CreateFirstIssuePlanResult,
): CreateFirstIssueApplyResult {
	const result = run(plan.commandArgv);
	if (!result.ok) {
		const reason = result.stderr.trim() || result.stdout.trim();
		return {
			ok: false,
			issue: null,
			blockers: [
				reason
					? `gh issue create failed: ${reason.split("\n")[0]}`
					: "gh issue create failed with no output.",
			],
			nextActions: [
				"Fix the gh command error and rerun `rhapsody create-first-issue --yes`.",
			],
		};
	}
	const parsed = parseIssueCreateCommandOutput(result.stdout);
	if (!parsed.ok) {
		return {
			ok: false,
			issue: null,
			blockers: [parsed.error],
			nextActions: [
				"Retry after confirming gh issue create prints a full issue URL to stdout.",
			],
		};
	}
	return {
		ok: true,
		issue: {
			number: parsed.issueNumber,
			url: parsed.issueUrl,
		},
		blockers: [],
		nextActions: [
			`Continue with \`rhapsody first-issue --url <preview-url> --issue-number ${parsed.issueNumber}\`.`,
			`Created issue: ${parsed.issueUrl}`,
		],
	};
}

function printCreateFirstIssueResult({
	json,
	plan,
}: {
	json: boolean;
	plan: {
		ok: boolean;
		mode: CommandMode;
		statePath: string;
		repository: string | null;
		title: string;
		bodyPreview: string;
		plannedCommand: string;
		blockers: string[];
		nextActions: string[];
		issue?: { number: number; url: string } | null;
	};
}) {
	if (json) {
		console.log(
			JSON.stringify(
				{
					ok: plan.ok,
					mode: plan.mode,
					statePath: plan.statePath,
					repository: plan.repository,
					title: plan.title,
					bodyPreview: plan.bodyPreview,
					plannedCommand: plan.plannedCommand,
					blockers: plan.blockers,
					nextActions: plan.nextActions,
					...(plan.issue ? { issue: plan.issue } : {}),
				},
				null,
				2,
			),
		);
		return;
	}

	console.log(`Rhapsody setup create-first-issue (${plan.mode})`);
	console.log(`Repository: ${plan.repository ?? "unknown"}`);
	console.log(`State path: ${plan.statePath}`);
	console.log(`Planned command: ${plan.plannedCommand}`);
	console.log(`Title: ${plan.title}`);
	console.log(`Body preview: ${plan.bodyPreview}`);
	if (plan.blockers.length > 0) {
		console.log("\nBlockers:");
		for (const blocker of plan.blockers) {
			console.log(`  - ${blocker}`);
		}
	}
	if (plan.issue) {
		console.log(`Created issue: ${plan.issue.url}`);
	}
	if (plan.nextActions.length > 0) {
		console.log("\nNext actions:");
		for (const action of plan.nextActions) {
			console.log(`  - ${action}`);
		}
	}
}

function run(command: string[]): SyncCommandResult {
	const result = spawnSync(command[0], command.slice(1), {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return {
		ok: result.status === 0,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function createBodyPreview(value: string): string {
	if (value.length <= BODY_PREVIEW_MAX) {
		return value;
	}
	return `${value.slice(0, BODY_PREVIEW_MAX)}...`;
}

function quoteForCommandPreview(value: string): string {
	if (value.includes(" ") || value.includes('"') || value.includes("'")) {
		return `"${value.replace(/"/g, '\\\"')}"`;
	}
	return value;
}
