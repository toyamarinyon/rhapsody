import { existsSync } from "node:fs";
import path from "node:path";

export function parseVercelAuthCandidates(): string[] {
	return [
		path.join(
			process.env.HOME ?? "",
			"Library",
			"Application Support",
			"com.vercel.cli",
			"auth.json",
		),
		path.join(
			process.env.HOME ?? "",
			".local",
			"share",
			"com.vercel.cli",
			"auth.json",
		),
	];
}

export function hasVercelTokenCandidate(): boolean {
	for (const candidate of parseVercelAuthCandidates()) {
		if (existsSync(candidate)) return true;
	}
	return Boolean(process.env.VERCEL_TOKEN);
}
