import { runSmokeTestCommand as runSmokeTest } from "../system.js";
import type { LegacyExitCode } from "../types.js";

export async function runSmokeTestCommand(
	args: string[],
): Promise<LegacyExitCode> {
	return runSmokeTest(args);
}
