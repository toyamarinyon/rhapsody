import { afterEach, expect, test, vi } from "vitest";

import { fetchProjectIssueWorkItems } from "@/lib/github/project-items";

afterEach(() => {
	vi.unstubAllGlobals();
});

test("fetchProjectIssueWorkItems extracts blocked_by project text field", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				data: {
					user: {
						projectV2: {
							items: {
								nodes: [
									{
										content: {
											__typename: "Issue",
											number: 42,
											title: "Blocked task",
											body: "Depends on another issue.",
											url: "https://github.com/toyamarinyon/rhapsody/issues/42",
											state: "OPEN",
											repository: {
												name: "rhapsody",
												owner: { login: "toyamarinyon" },
											},
										},
										fieldValues: {
											nodes: [
												{
													__typename: "ProjectV2ItemFieldSingleSelectValue",
													name: "Todo",
													field: { name: "Status" },
												},
												{
													__typename: "ProjectV2ItemFieldTextValue",
													text: "#40, toyamarinyon/rhapsody#41",
													field: { name: "blocked_by" },
												},
											],
										},
									},
								],
								pageInfo: { hasNextPage: false, endCursor: null },
							},
						},
					},
				},
			}),
		),
	);

	const items = await fetchProjectIssueWorkItems(
		{
			owner: "toyamarinyon",
			repository: "rhapsody",
			projectNumber: 4,
			statusField: "Status",
		},
		{ GITHUB_TOKEN: "test-token" },
	);

	expect(items).toHaveLength(1);
	expect(items[0]?.blockedBy).toEqual([
		{ id: "#40", state: "unknown" },
		{ id: "toyamarinyon/rhapsody#41", state: "unknown" },
	]);
	expect(items[0]?.projectFields).toEqual({
		Status: "Todo",
		blocked_by: "#40, toyamarinyon/rhapsody#41",
	});
});
