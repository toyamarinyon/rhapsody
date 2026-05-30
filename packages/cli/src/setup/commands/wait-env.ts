import { runWaitEnvCommand as runWaitEnv } from "../system.js";
import type { LegacyExitCode } from "../types.js";

export async function runWaitEnvCommand(
	args: string[],
): Promise<LegacyExitCode> {
	return runWaitEnv(args);
}
