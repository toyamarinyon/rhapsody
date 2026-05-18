import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	/* config options here */
	outputFileTracingIncludes: {
		"/api/v1/runs/[runId]/attempts/[attemptId]/prompt": ["./.rhapsody/INSTRUCTIONS.md"],
		"/api/v1/runs/[runId]/attempts/[attemptId]/sandbox-fake-runner": ["./.rhapsody/INSTRUCTIONS.md"],
	},
	reactCompiler: true,
};

export default nextConfig;
