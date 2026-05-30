import { runFirstIssueCommand as runFirstIssue } from "../system.js";
import type { LegacyExitCode } from "../types.js";

export async function runFirstIssueCommand(
	args: string[],
): Promise<LegacyExitCode> {
	return runFirstIssue(args);
}
