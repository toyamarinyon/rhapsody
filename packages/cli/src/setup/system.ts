#!/usr/bin/env node
export async function runSetupCommand(
	argv: string[] = process.argv.slice(2),
): Promise<number> {
	const command = argv[0] ?? "help";
	const subcommand = argv[1];
	const flags = new Set(argv.slice(1));

	if (command === "setup") {
		if (
			subcommand === undefined ||
			subcommand === "help" ||
			subcommand === "--help" ||
			subcommand === "-h"
		) {
			printSetupHelp();
			return 0;
		}

		if (
			subcommand &&
			![
				"status",
				"plan",
				"check-projects",
				"wait-env",
				"provision-turso",
				"deploy-preview",
				"smoke-test",
				"create-first-issue",
				"first-issue",
				"start-attempt",
			].includes(subcommand)
		) {
			printSetupPreview();
			return 0;
		}
		if (
			subcommand === "status" ||
			subcommand === "plan" ||
			subcommand === "check-projects" ||
			subcommand === "wait-env" ||
			subcommand === "provision-turso" ||
			subcommand === "deploy-preview" ||
			subcommand === "smoke-test" ||
			subcommand === "create-first-issue" ||
			subcommand === "first-issue" ||
			subcommand === "start-attempt"
		) {
			// Delegated to explicit command handlers in setup/commands.
			printSetupPreview();
			return 0;
		}
		if (flags.has("--json")) {
			printSetupPreview();
			return 0;
		}
		printSetupPreview();
		return 0;
	}

	if (command === "help" || command === "--help" || command === "-h") {
		printHelp();
		return 0;
	}

	console.error(`Unknown command: ${command}`);
	console.error("Run `rhapsody --help` for available commands.");
	return 1;
}

function printHelp() {
	console.log(`Rhapsody setup CLI

Usage:
  rhapsody setup [--help]

Commands:
  setup   Prepare a self-hosted Rhapsody deployment
`);
}

function printSetupPreview() {
	console.log(`Rhapsody setup CLI scaffold is installed.

Next implementation step:
  add authentication and status probes for gh, Vercel CLI, and the app workspace.

For the current helper flow, run:
  pnpm setup:plan
`);
}

function printSetupHelp() {
	console.log(`Usage:
  rhapsody setup
  rhapsody setup status [--json]
  rhapsody setup check-projects [--json]
  rhapsody setup plan [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]
  rhapsody setup wait-env [--json] [--timeout <seconds>] [--interval <seconds>]
  rhapsody setup create-first-issue [--dry-run] [--json] [--title <title>] [--body <body>]
  rhapsody setup create-first-issue --yes [--json] [--title <title>] [--body <body>]
  rhapsody setup deploy-preview --dry-run [--json]
  rhapsody setup deploy-preview --yes [--json]
  rhapsody setup first-issue --url <preview-url> --issue-number <n> [--json] [--use-root-password]
  rhapsody setup first-issue --url <preview-url> --issue-number <n> --apply --yes --use-root-password [--json]
  rhapsody setup start-attempt --url <preview-url> --run-id <runId> --attempt-id <attemptId> [--json] [--use-root-password]
  rhapsody setup start-attempt --url <preview-url> --run-id <runId> --attempt-id <attemptId> --apply --yes --use-root-password [--json]
  rhapsody setup smoke-test --url <preview-url> [--json] [--use-root-password]
  rhapsody setup provision-turso --dry-run [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]
  rhapsody setup provision-turso --yes [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]

The setup command will orchestrate the self-hosted Rhapsody install flow.

Planned phases:
  1. Detect gh and Vercel CLI authentication
  2. Prepare or publish the GitHub repository
  3. Create or reuse the Vercel project
  4. Provision Turso through Vercel Marketplace
  5. Configure Vercel environment variables
  6. Run database migration
  7. Deploy and smoke-test Rhapsody
  8. Hand off the first GitHub Project issue
`);
}
