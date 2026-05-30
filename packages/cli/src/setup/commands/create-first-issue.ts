import { runCreateFirstIssueCommand as runCreateFirstIssue } from "../system.js";
import type { LegacyExitCode } from "../types.js";

export async function runCreateFirstIssueCommand(
	args: string[],
): Promise<LegacyExitCode> {
	return runCreateFirstIssue(args);
}
