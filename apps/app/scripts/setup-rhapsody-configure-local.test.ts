import { expect, test } from "vitest";
import { buildDryRunNextActions } from "@/scripts/setup-rhapsody-configure-local";

test("builds concrete configure-local recovery for unsafe env writes", () => {
	expect(
		buildDryRunNextActions({
			blocked: [
				".env.local is missing and is not ignored by git, so it must not be created until ignore rules are fixed.",
			],
			planProjectNumber: false,
			projectNumberWouldWrite: false,
			missingGeneratedSecrets: ["CRON_SECRET"],
			missingExternalInputs: ["VERCEL_TOKEN"],
			needsUser: ["Provide VERCEL_TOKEN in process env or .env.local."],
		}),
	).toEqual([
		"Add `.env.local` to .gitignore or another ignore rule, then rerun `pnpm setup:configure-local -- --dry-run` before any local secret write.",
		"Provide VERCEL_TOKEN in process env or .env.local.",
		"Create a Vercel API token in Vercel account settings, then expose it as VERCEL_TOKEN for configure-deploy and deploy-preview.",
	]);
});
