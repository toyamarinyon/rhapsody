import { runStartAttemptCommand as runStartAttempt } from "../system.js";
import type { LegacyExitCode } from "../types.js";

export async function runStartAttemptCommand(
	args: string[],
): Promise<LegacyExitCode> {
	return runStartAttempt(args);
}
