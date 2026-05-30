import { runPlanCommand as runPlan } from "../system.js";
import type { LegacyExitCode } from "../types.js";

export async function runPlanCommand(args: string[]): Promise<LegacyExitCode> {
	return runPlan(args);
}
