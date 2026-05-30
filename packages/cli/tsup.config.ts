import { defineConfig } from "tsup";

export default defineConfig({
	entry: { bin: "src/main.ts" },
	format: ["esm"],
	platform: "node",
	target: "node22",
	outDir: "dist",
	clean: true,
	dts: false,
});
