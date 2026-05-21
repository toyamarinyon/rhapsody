import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	/* config options here */
	typescript: {
		// Keep TypeScript and wrapper syntax checks in `pnpm typecheck` so
		// `pnpm build` stays focused on producing the Next.js build output.
		ignoreBuildErrors: true,
	},
	outputFileTracingIncludes: {
		"/*": [
			"./.rhapsody/INSTRUCTIONS.md",
			"./.rhapsody/config.toml",
			"./lib/runners/sandbox-codex-wrapper/wrapper.cjs",
		],
	},
	reactCompiler: true,
};

export default withWorkflow(nextConfig);
