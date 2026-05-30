import { runDeployPreviewCommand as runDeployPreview } from "../system.js";
import type { LegacyExitCode } from "../types.js";

export async function runDeployPreviewCommand(
	args: string[],
): Promise<LegacyExitCode> {
	return runDeployPreview(args);
}
