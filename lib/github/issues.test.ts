import { afterEach, expect, test, vi } from "vitest";

import {
	fetchIssueDependenciesBlockedBy,
	GitHubIssueFetchError,
} from "@/lib/github/issues";

const originalFetch = global.fetch;

afterEach(() => {
	global.fetch = originalFetch;
});

test("fetchIssueDependenciesBlockedBy returns normalized issue dependencies", async () => {
	global.fetch = vi.fn(async () =>
		Response.json({
			nodes: [
				{
					id: 1,
					node_id: "MDU6SXNzdWUx",
					number: 7,
					title: "Blocker",
					html_url: "https://github.com/octo/org/issues/7",
					state: "open",
					repository_url: "https://api.github.com/repos/octo/rhapsody",
				},
			],
		}),
	);

	const result = await fetchIssueDependenciesBlockedBy(
		{
			owner: "octo",
			repository: "rhapsody",
			issueNumber: 12,
		},
		{
			GITHUB_TOKEN: "test-token",
		},
	);

	expect(result).toEqual([
		{
			id: "1",
			nodeId: "MDU6SXNzdWUx",
			number: 7,
			title: "Blocker",
			htmlUrl: "https://github.com/octo/org/issues/7",
			repositoryUrl: "https://api.github.com/repos/octo/rhapsody",
			state: "open",
			repository: { owner: "octo", name: "rhapsody" },
		},
	]);
	expect(global.fetch).toHaveBeenCalledWith(
		"https://api.github.com/repos/octo/rhapsody/issues/12/dependencies/blocked_by",
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: "Bearer test-token",
				"X-GitHub-Api-Version": "2026-03-10",
			},
		},
	);
});

test("fetchIssueDependenciesBlockedBy fails when GitHub API returns error", async () => {
	global.fetch = vi.fn(async () =>
		Response.json({ message: "forbidden" }, { status: 403 }),
	);

	await expect(
		fetchIssueDependenciesBlockedBy(
			{
				owner: "octo",
				repository: "rhapsody",
				issueNumber: 12,
			},
			{
				GITHUB_TOKEN: "test-token",
			},
		),
	).rejects.toBeInstanceOf(GitHubIssueFetchError);
});

test("fetchIssueDependenciesBlockedBy rejects malformed dependency payload", async () => {
	global.fetch = vi.fn(async () =>
		Response.json({
			nodes: [
				{
					id: 12,
				} as never,
			],
		}),
	);

	await expect(
		fetchIssueDependenciesBlockedBy(
			{
				owner: "octo",
				repository: "rhapsody",
				issueNumber: 12,
			},
			{
				GITHUB_TOKEN: "test-token",
			},
		),
	).rejects.toThrow("unexpected shape");
});

test("fetchIssueDependenciesBlockedBy rejects unexpected response shape", async () => {
	global.fetch = vi.fn(async () =>
		Response.json({
			message: "unsupported shape",
		}),
	);

	await expect(
		fetchIssueDependenciesBlockedBy(
			{
				owner: "octo",
				repository: "rhapsody",
				issueNumber: 13,
			},
			{
				GITHUB_TOKEN: "test-token",
			},
		),
	).rejects.toThrow("unexpected response shape");
});
