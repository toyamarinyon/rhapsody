import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import raulaTailwind from "eslint-plugin-raula/tailwind";
import raulaNextLayout from "eslint-plugin-raula/next-layout";

const eslintConfig = defineConfig([
	...raulaTailwind,
	...raulaNextLayout,
	...nextVitals,
	...nextTs,
	// Override default ignores of eslint-config-next.
	globalIgnores([
		// Default ignores of eslint-config-next:
		".next/**",
		"out/**",
		"build/**",
		"next-env.d.ts",
		"app/.well-known/workflow/v1/**",
	]),
]);

export default eslintConfig;
