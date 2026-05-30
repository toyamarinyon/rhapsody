import { expect, test } from "vitest";
import { summarizeVercelAuth } from "@/scripts/setup-rhapsody-deploy-preview";

test("summarizes Vercel auth timeouts with operator recovery", () => {
	expect(
		summarizeVercelAuth({
			status: null,
			signal: "SIGTERM",
			output: [],
			pid: 123,
			stdout: "",
			stderr: "",
			error: Object.assign(new Error("spawnSync vercel ETIMEDOUT"), {
				code: "ETIMEDOUT",
			}),
		}),
	).toBe(
		"vercel whoami timed out after 12000ms; provide VERCEL_TOKEN, run `vercel login`, or rerun when the CLI is responsive",
	);
});
