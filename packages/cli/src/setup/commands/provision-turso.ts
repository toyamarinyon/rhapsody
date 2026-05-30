import { runProvisionTursoCommand as runProvision } from "../system.js";
import type { LegacyExitCode } from "../types.js";

export async function runProvisionTursoCommand(
	args: string[],
): Promise<LegacyExitCode> {
	return runProvision(args);
}
