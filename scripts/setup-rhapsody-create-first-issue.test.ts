import { expect, test } from "vitest";
import {
	buildBlockedNextActions,
	buildCommandEnv,
	buildPartialIssueProjectActions,
	buildUnsupportedArgsReport,
	parseArgs,
	parseIssueCreateUrl,
} from "@/scripts/setup-rhapsody-create-first-issue";

test("parses GitHub issue URL and issue number from gh issue-create stdout", () => {
	const stdout =
		"Creating issue in repo test/repo\nhttps://github.com/example/test-repo/issues/12345\nDone\n";

	expect(parseIssueCreateUrl(stdout)).toEqual({
		ok: true,
		issueUrl: "https://github.com/example/test-repo/issues/12345",
		issueNumber: 12345,
	});
});

test("fails to parse invalid gh issue-create stdout", () => {
	expect(parseIssueCreateUrl("issue created\n")).toEqual({
		ok: false,
		error: "gh issue create did not print a parseable issue URL",
	});
});

test("parses default and apply/yes arguments", () => {
	expect(parseArgs(["node", "script.ts"])).toEqual({
		mode: "dry-run",
		title: null,
		body: null,
	});
	expect(
		parseArgs([
			"node",
			"script.ts",
			"--",
			"--title",
			"Title One",
			"--body",
			"Body One",
		]),
	).toEqual({
		mode: "dry-run",
		title: "Title One",
		body: "Body One",
	});
	expect(
		parseArgs([
			"node",
			"script.ts",
			"--apply",
			"--yes",
			"--title=Smoke test",
			"--body=Body",
		]),
	).toEqual({
		mode: "apply",
		title: "Smoke test",
		body: "Body",
	});
	expect(parseArgs(["node", "script.ts", "--apply"])).toEqual(null);
	expect(parseArgs(["node", "script.ts", "--yes"])).toEqual(null);
	expect(parseArgs(["node", "script.ts", "--unknown"])).toEqual(null);
	expect(parseArgs(["node", "script.ts", "--title"])).toEqual(null);
	expect(parseArgs(["node", "script.ts", "--body"])).toEqual(null);
});

test("builds partial-success follow-up actions when project item-add fails", () => {
	const actions = buildPartialIssueProjectActions({
		issueNumber: 77,
		issueUrl: "https://github.com/example/test/issues/77",
	});

	expect(actions).toEqual({
		needsUser: [
			"Add the issue to the ProjectV2 board manually if required.",
			"Issue was created as #77 at https://github.com/example/test/issues/77.",
			"Continue with setup:first-issue using --issue-number 77.",
		],
		blocked: [
			"The issue was created but could not be added to ProjectV2.",
			"Issue remains available for manual recovery: #77 (https://github.com/example/test/issues/77).",
		],
		nextActions: [
			"Run the issue handoff manually using the existing issue number #77 and URL https://github.com/example/test/issues/77.",
			"Then run: pnpm setup:first-issue -- --url <preview-url> --issue-number 77.",
		],
	});
});

test("builds a concrete nextActions list when arguments are unsupported", () => {
	expect(buildUnsupportedArgsReport("Unsupported arguments.")).toMatchObject({
		ok: false,
		nextActions: [
			'Run "pnpm setup:create-first-issue -- --title <title> --body <body>" for a dry-run check.',
			'Run "pnpm setup:create-first-issue -- --apply --yes --title <title>" to create an issue.',
		],
		blocked: ["Unsupported or missing arguments."],
		needsUser: [
			"Use --title <title>, optional --body <body>, optional --apply --yes to run.",
		],
	});
});

test("builds concrete blocked nextActions for first issue preconditions", () => {
	expect(
		buildBlockedNextActions({
			ghAvailable: true,
			ghAuthOk: true,
			repoResolved: false,
			repoAccessible: false,
			configExists: true,
			projectNumberConfigured: false,
		}),
	).toEqual([
		"Configure tracker.owner/repository in rhapsody.config.ts or add a valid GitHub origin remote, then rerun `pnpm setup:create-first-issue -- --dry-run`.",
		"Run `pnpm setup:configure-github -- --dry-run`, then persist the ProjectV2 number with `pnpm setup:configure-local -- --apply --yes --project-number <number>`.",
	]);
});

test("maps GITHUB_TOKEN to GH_TOKEN for gh subprocesses", () => {
	const previousGhToken = process.env.GH_TOKEN;
	const previousGithubToken = process.env.GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
	process.env.GITHUB_TOKEN = "token-for-test";
	try {
		expect(buildCommandEnv("gh").GH_TOKEN).toBe("token-for-test");
		expect(buildCommandEnv("git").GH_TOKEN).toBeUndefined();
	} finally {
		if (previousGhToken === undefined) {
			delete process.env.GH_TOKEN;
		} else {
			process.env.GH_TOKEN = previousGhToken;
		}
		if (previousGithubToken === undefined) {
			delete process.env.GITHUB_TOKEN;
		} else {
			process.env.GITHUB_TOKEN = previousGithubToken;
		}
	}
});
