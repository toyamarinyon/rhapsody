import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";

const projectRoot = pathToFileURL(`${process.cwd()}/`).href;

export async function resolve(specifier, context, nextResolve) {
	if (specifier.startsWith("@/")) {
		const path = specifier.slice(2);
		const fileUrl = new URL(`${path}.ts`, projectRoot);
		const indexUrl = new URL(`${path}/index.ts`, projectRoot);
		const resolved = existsSync(fileUrl) ? fileUrl : indexUrl;
		return { shortCircuit: true, url: resolved.href };
	}

	try {
		return await nextResolve(specifier, context);
	} catch (error) {
		if (
			error?.code === "ERR_MODULE_NOT_FOUND" &&
			(specifier.startsWith("./") || specifier.startsWith("../")) &&
			!specifier.endsWith(".ts")
		) {
			const resolved = new URL(`${specifier}.ts`, context.parentURL);
			return { shortCircuit: true, url: resolved.href };
		}

		throw error;
	}
}
