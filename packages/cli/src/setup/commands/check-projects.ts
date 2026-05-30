import { runCheckProjectsCommand as runCheckProjects } from "../system.js";
import type { LegacyExitCode } from "../types.js";

export async function runCheckProjectsCommand(
	args: string[],
): Promise<LegacyExitCode> {
	return runCheckProjects(args);
}
