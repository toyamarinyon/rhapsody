import { expect, test } from "vitest";
import { buildCommandEnv } from "@/scripts/setup-rhapsody-configure-github";

test("maps GITHUB_TOKEN to GH_TOKEN for gh subprocesses", () => {
	const previousGhToken = process.env.GH_TOKEN;
	const previousGithubToken = process.env.GITHUB_TOKEN;
	delete process.env.GH_TOKEN;
	process.env.GITHUB_TOKEN = "token-for-test";
	try {
		expect(buildCommandEnv("gh").GH_TOKEN).toBe("token-for-test");
		expect(buildCommandEnv("git").GH_TOKEN).toBeUndefined();
	} finally {
		if (previousGhToken === undefined) {
			delete process.env.GH_TOKEN;
		} else {
			process.env.GH_TOKEN = previousGhToken;
		}
		if (previousGithubToken === undefined) {
			delete process.env.GITHUB_TOKEN;
		} else {
			process.env.GITHUB_TOKEN = previousGithubToken;
		}
	}
});
