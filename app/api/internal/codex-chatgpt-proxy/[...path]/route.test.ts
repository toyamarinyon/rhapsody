import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as state from "@/lib/state";
import {
	buildExpectedOidcAudience,
	isProxyRunContextActive,
	type ProxyRunContext,
	parseProxyPath,
} from "./route";

describe("codex chatgpt proxy path and run context auth", () => {
	let restoreProjectId: string | undefined;
	let restoreTeamId: string | undefined;

	beforeEach(() => {
		restoreProjectId = process.env.VERCEL_PROJECT_ID;
		restoreTeamId = process.env.VERCEL_TEAM_ID;
		process.env.VERCEL_PROJECT_ID = "prj_123";
		process.env.VERCEL_TEAM_ID = "team_123";
	});

	afterEach(() => {
		if (restoreProjectId === undefined) {
			delete process.env.VERCEL_PROJECT_ID;
		} else {
			process.env.VERCEL_PROJECT_ID = restoreProjectId;
		}
		if (restoreTeamId === undefined) {
			delete process.env.VERCEL_TEAM_ID;
		} else {
			process.env.VERCEL_TEAM_ID = restoreTeamId;
		}
		vi.restoreAllMocks();
	});

	test("parseProxyPath supports runs/ID/attempts/ID with upstream codex/chatgpt paths", () => {
		const parsed = parseProxyPath([
			"runs",
			"run-1",
			"attempts",
			"github_issue%3Aabc%231",
			"codex",
			"chatgpt",
			"backend-api",
			"responses",
		]);

		expect(parsed.runContext).toEqual({
			runId: "run-1",
			attemptId: "github_issue%3Aabc%231",
			audienceSuffix: "/codex/chatgpt",
		});
		expect(parsed.upstreamPath).toBe("/backend-api/responses");
		expect(
			buildExpectedOidcAudience(
				"https://example.com",
				parsed.runContext as ProxyRunContext,
			),
		).toBe(
			"https://example.com/api/internal/codex-chatgpt-proxy/runs/run-1/attempts/github_issue%3Aabc%231/codex/chatgpt",
		);
	});

	test("isProxyRunContextActive validates legacy run/attempt context", async () => {
		const client = { close: vi.fn() } as never;
		const getRunDetail = vi.spyOn(state, "getRunDetail").mockResolvedValue({
			run: { status: "running", workItemId: "workitem" } as never,
			attempts: [{ id: "attempt-1", status: "running" } as never],
			events: [],
			claim: null,
		}) as never;

		vi.spyOn(state, "createStateStoreClient").mockReturnValue(client);

		await expect(
			isProxyRunContextActive({
				runId: "run-1",
				attemptId: "attempt-1",
				audienceSuffix: "",
			}),
		).resolves.toBe(true);
		expect(getRunDetail).toHaveBeenCalledTimes(1);
	});

	test("isProxyRunContextActive validates intake run-context via work item id", async () => {
		const client = { close: vi.fn() } as never;
		const workItemId = "github_issue:org/repo#12";
		const encodedWorkItemId = encodeURIComponent(workItemId);

		vi.spyOn(state, "getRunDetail").mockResolvedValue(null);
		vi.spyOn(state, "listWorkItemGraph").mockResolvedValue({
			workItemId,
			workerRuns: [
				{
					id: "wrn-intake",
					workItemId,
					kind: "intake_curator",
					status: "running",
					metadata: {},
					workItemSnapshot: {},
					startedAt: 1,
					finishedAt: null,
					createdAt: 1,
					updatedAt: 1,
				} as never,
			],
			decisions: [],
			artifacts: [],
			links: [],
		} as never);
		vi.spyOn(state, "createStateStoreClient").mockReturnValue(client);

		await expect(
			isProxyRunContextActive({
				runId: "wrn-intake",
				attemptId: encodedWorkItemId,
				audienceSuffix: "",
			}),
		).resolves.toBe(true);
		await expect(
			isProxyRunContextActive({
				runId: "wrn-intake",
				attemptId: encodeURIComponent("github_issue:other#12"),
				audienceSuffix: "",
			}),
		).resolves.toBe(false);
	});
});
