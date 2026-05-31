#!/usr/bin/env node
export async function runSetupCommand(
	argv: string[] = process.argv.slice(2),
): Promise<number> {
	const command = argv[0] ?? "help";

	if (command === "help" || command === "--help" || command === "-h") {
		printHelp();
		return 0;
	}

	if (command === "setup") {
		printSetupHelp();
		return 0;
	}

	if (command === "doctor") {
		printDoctorHelp();
		return 0;
	}

	if (command === "plan") {
		printPlanHelp();
		return 0;
	}

	if (
		command === "deploy-preview" ||
		command === "provision-turso" ||
		command === "wait-env" ||
		command === "smoke-test" ||
		command === "create-first-issue" ||
		command === "first-issue" ||
		command === "start-attempt" ||
		command === "check-projects"
	) {
		printManualCommandHelp();
		return 0;
	}

	console.error(`Unknown command: ${command}`);
	console.error("Run `rhapsody --help` for available commands.");
	return 1;
}

function printHelp() {
	console.log(`Rhapsody CLI

Usage:
  rhapsody setup [--yes] [--json] [--project-name <name>]
  rhapsody doctor [--json]
  rhapsody plan [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]
  rhapsody deploy-preview [--dry-run|--yes] [--json]
  rhapsody provision-turso [--dry-run|--yes] [--json] [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>]
  rhapsody wait-env [--json] [--timeout <seconds>] [--interval <seconds>]
  rhapsody smoke-test --url <preview-url> [--json]
  rhapsody create-first-issue [--dry-run] [--json]
  rhapsody first-issue [--url <preview-url>] [--issue-number <n>] [--json]
  rhapsody start-attempt [--url <preview-url>] [--run-id <runId>] [--attempt-id <attemptId>] [--json]

Commands:
  setup               Run the end-to-end setup orchestrator
  doctor              Diagnose environment and project state
  plan                Print the detailed setup plan
  deploy-preview      Create or verify a preview deploy
  provision-turso     Provision Turso through Vercel Marketplace
  wait-env            Wait for required Vercel env vars
  smoke-test          Run post-deploy smoke test
  create-first-issue   Create the first setup issue
  first-issue         Start the first setup run attempt
  start-attempt       Start an attempt against a running preview
`);
}

function printSetupHelp() {
	console.log(`Usage:
  rhapsody setup [--yes] [--json] [--project-name <name>]

Run setup end-to-end with safe checks first.
	Pass \`--yes\` to allow remote/external mutations.
	Pass \`--project-name\` to create or reuse a specific Vercel project.
`);
}

function printDoctorHelp() {
	console.log(`Usage:
  rhapsody doctor
  rhapsody doctor --json

Runs environment and project readiness diagnostics.
`);
}

function printPlanHelp() {
	console.log(`Usage:
  rhapsody plan [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>] [--json]
`);
}

function printManualCommandHelp() {
	console.log(`Usage:
  rhapsody deploy-preview [--dry-run|--yes] [--json]
  rhapsody provision-turso [--dry-run|--yes] [--json] [--region <iad1|cle1|pdx1|dub1|bom1|hnd1>]
  rhapsody wait-env [--json] [--timeout <seconds>] [--interval <seconds>]
  rhapsody smoke-test --url <preview-url> [--json]
  rhapsody create-first-issue [--dry-run] [--json] [--title <title>] [--body <body>]
  rhapsody first-issue [--url <preview-url>] [--issue-number <n>] [--json] [--use-root-password]
  rhapsody first-issue [--url <preview-url>] [--issue-number <n>] --apply --yes --use-root-password [--json]
  rhapsody start-attempt [--url <preview-url>] [--run-id <runId>] [--attempt-id <attemptId>] [--json] [--use-root-password]
  rhapsody start-attempt [--url <preview-url>] [--run-id <runId>] [--attempt-id <attemptId>] --apply --yes --use-root-password [--json]
`);
}
