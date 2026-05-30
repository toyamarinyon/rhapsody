import { collectDeployPreviewBlockers } from "../vercel.js";
import type {
	ParseResult,
	ParseSetupPlanResult,
	Region,
	SetupPlanPhase,
	SetupPlanResult,
	LegacyExitCode,
} from "../types.js";
import { collectSetupStatus } from "./status.js";

export async function runPlanCommand(args: string[]): Promise<LegacyExitCode> {
	const parse = parseSetupPlanArgs(args);
	if (parse.ok === false) {
		console.error(parse.error);
		process.exit(1);
	}

	const status = collectSetupStatus();
	const planned = buildSetupPlan({ status, region: parse.region });
	printSetupPlan({ json: parse.json, plan: planned });
	process.exit(planned.ok ? 0 : 0);
}

function parseSetupPlanArgs(args: string[]): ParseSetupPlanResult {
	const parsedRegion = parseRegionFlag(args);
	if (isParseFailure(parsedRegion)) {
		return { ok: false, error: parsedRegion.error };
	}

	return {
		ok: true,
		json: args.includes("--json"),
		region: parsedRegion.region,
	};
}

function parseRegionFlag(args: string[]): ParseResult<{ region: Region }> {
	const allowedRegions = new Set([
		"iad1",
		"cle1",
		"pdx1",
		"dub1",
		"bom1",
		"hnd1",
	]);
	let region: Region = "hnd1";
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") continue;
		if (arg === "--region") {
			const value = args[i + 1];
			if (!value) {
				return {
					ok: false,
					error:
						"Missing value for --region. Use one of: iad1, cle1, pdx1, dub1, bom1, hnd1.",
				};
			}
			if (!allowedRegions.has(value)) {
				return {
					ok: false,
					error: `Invalid region: ${value}. Valid regions: iad1, cle1, pdx1, dub1, bom1, hnd1.`,
				};
			}
			region = value as Region;
			continue;
		}
		if (arg.startsWith("--region=")) {
			const value = arg.slice("--region=".length);
			if (!allowedRegions.has(value)) {
				return {
					ok: false,
					error: `Invalid region: ${value}. Valid regions: iad1, cle1, pdx1, dub1, bom1, hnd1.`,
				};
			}
			region = value as Region;
			continue;
		}
	}

	return {
		ok: true,
		region,
	};
}

function isParseFailure<TData>(
	value: ParseResult<TData>,
): value is { ok: false; error: string } {
	return value.ok === false;
}

function printSetupPlan({
	json,
	plan,
}: {
	json: boolean;
	plan: SetupPlanResult;
}) {
	if (json) {
		console.log(JSON.stringify(plan, null, 2));
		return;
	}

	console.log(`Rhapsody setup plan\n\nRegion: ${plan.region}`);

	for (const phase of plan.phases) {
		const marker = phase.status === "blocked" ? "[!]" : "[ ]";
		console.log(`${marker} ${phase.name}`);
		console.log(`    command: ${phase.command}`);
	}

	console.log("\nNext actions:");
	for (const action of plan.nextActions) {
		console.log(`  - ${action}`);
	}
}

function buildSetupPlan({
	status,
	region,
}: {
	status: ReturnType<typeof collectSetupStatus>;
	region: Region;
}): SetupPlanResult {
	const tursoCommand =
		"npx -y vercel@53 integration add tursocloud --name rhapsody-db --plan starter -m region=" +
		region +
		" -e production -e preview -e development --no-env-pull";

	const phases = [
		{
			name: "Auth check",
			command: "gh auth status && vercel whoami",
			status:
				status.tools.gh.installed && status.tools.vercel.installed
					? "ready"
					: "blocked",
		},
		{
			name: "GitHub repo/project prep",
			command: "rhapsody setup check-projects --json",
			status:
				status.tools.gh.installed && status.tools.gh.authTokenPresent
					? "ready"
					: "blocked",
		},
		{
			name: "Vercel project link/create",
			command: "rhapsody setup check-projects --json",
			status: status.app.vercelProjectLink.exists ? "ready" : "ready",
		},
		{
			name: "Turso Marketplace provisioning",
			command: tursoCommand,
			status:
				status.app.env.tursoDatabaseUrlPresent &&
				status.app.env.tursoAuthTokenPresent
					? "ready"
					: "ready",
		},
		{
			name: "Vercel env setup",
			command: "rhapsody setup wait-env",
			status: status.app.env.tursoDatabaseUrlPresent ? "ready" : "ready",
		},
		{
			name: "Database migration and deploy preview",
			command: "rhapsody setup deploy-preview --dry-run",
			status:
				collectDeployPreviewBlockers(status).length === 0 ? "ready" : "blocked",
		},
		{
			name: "Smoke test",
			command: "rhapsody setup smoke-test --url <preview-url>",
			status: "ready",
		},
		{
			name: "Attempt start",
			command:
				"rhapsody setup start-attempt --url <preview-url> --run-id <runId> --attempt-id <attemptId>",
			status: "ready",
		},
	];

	return {
		ok: status.ok,
		region,
		phases: phases.map((phase) => ({
			name: phase.name,
			command: phase.command,
			status: phase.status === "blocked" ? "blocked" : "ready",
		})),
		commands: phases.map((phase) => phase.command),
		nextActions: status.nextActions,
	};
}
