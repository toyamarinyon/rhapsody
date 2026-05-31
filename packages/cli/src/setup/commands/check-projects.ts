import type { LegacyExitCode } from "../types.js";
import { collectProjectReadiness, printSetupCheckProjects } from "./status.js";

export async function runCheckProjectsCommand(
	args: string[],
): Promise<LegacyExitCode> {
	const parse = parseSetupCheckProjectsArgs(args);
	if (parse.ok === false) {
		console.error(parse.error);
		process.exit(1);
	}

	const readiness = collectProjectReadiness();
	printSetupCheckProjects({ json: parse.json, readiness });
	process.exit(readiness.ok ? 0 : 1);
}

function parseSetupCheckProjectsArgs(args: string[]) {
	if (args.includes("--help") || args.includes("-h")) {
		return {
			ok: false,
			error: "Usage: rhapsody check-projects [--json]",
		} as const;
	}
	return {
		ok: true,
		json: args.includes("--json"),
	} as const;
}
