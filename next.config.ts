import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	/* config options here */
	outputFileTracingIncludes: {
		"/*": ["./.rhapsody/INSTRUCTIONS.md"],
	},
	reactCompiler: true,
};

export default nextConfig;
