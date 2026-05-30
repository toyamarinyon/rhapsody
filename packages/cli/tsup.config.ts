import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/bin.ts"],
	format: ["esm"],
	platform: "node",
	target: "node22",
	outDir: "dist",
	clean: true,
	dts: false,
});
