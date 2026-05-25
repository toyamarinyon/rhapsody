import { afterEach, describe, expect, test, vi } from "vitest";
import * as state from "@/lib/state";
import type { RunDetail, WorkItemGraph } from "@/lib/state";
import {
	buildExpectedOidcAudience,
	isProxyRunContextActive,
	type ProxyRunContext,
	parseProxyPath,
} from "./proxy-auth";

describe("codex proxy auth helpers", () => {
	afterEach(() => {
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
		const client = {
			close: vi.fn(),
		} as unknown as ReturnType<typeof state.createStateStoreClient>;
		const getRunDetail = vi.spyOn(state, "getRunDetail").mockResolvedValue({
			run: { status: "running", workItemId: "workitem" } as never,
			attempts: [{ id: "attempt-1", status: "running" } as never],
			events: [],
			claim: null,
		} as RunDetail);

		vi.spyOn(state, "createStateStoreClient").mockReturnValue(client);

		expect(
			await isProxyRunContextActive({
				runId: "run-1",
				attemptId: "attempt-1",
				audienceSuffix: "",
			}),
		).toBe(true);
		expect(getRunDetail).toHaveBeenCalledTimes(1);
		expect(client.close).toHaveBeenCalledTimes(1);
	});

	test("isProxyRunContextActive validates intake run-context via work item id", async () => {
		const client = {
			close: vi.fn(),
		} as unknown as ReturnType<typeof state.createStateStoreClient>;
		const workItemId = "github_issue:org/repo#12";
		const encodedWorkItemId = Buffer.from(workItemId, "utf8").toString(
			"base64url",
		);
		const mismatchedWorkItemId = "github_issue:other#12";
		const listWorkItemGraph = vi
			.spyOn(state, "listWorkItemGraph")
			.mockImplementation(
				async () =>
					({
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
					}) as WorkItemGraph,
			);

		vi.spyOn(state, "getRunDetail").mockResolvedValue(null);
		vi.spyOn(state, "createStateStoreClient").mockReturnValue(client);

		expect(
			await isProxyRunContextActive({
				runId: "wrn-intake",
				attemptId: encodedWorkItemId,
				audienceSuffix: "",
			}),
		).toBe(true);
		expect(
			await isProxyRunContextActive({
				runId: "wrn-intake",
				attemptId: Buffer.from(mismatchedWorkItemId, "utf8").toString(
					"base64url",
				),
				audienceSuffix: "",
			}),
		).toBe(false);
		expect(
			await isProxyRunContextActive({
				runId: "wrn-intake",
				attemptId: "%",
				audienceSuffix: "",
			}),
		).toBe(false);

		const graphLookupIds = listWorkItemGraph.mock.calls.map((call) => call[1]);
		expect(graphLookupIds).toContain(workItemId);
		expect(graphLookupIds).toContain(mismatchedWorkItemId);
		expect(client.close).toHaveBeenCalledTimes(3);
	});
});
