import { runStatusCommand as runStatus } from "../system.js";
import type { LegacyExitCode } from "../types.js";

export async function runStatusCommand(
	args: string[],
): Promise<LegacyExitCode> {
	return runStatus(args);
}
