import type { Octokit } from "@octokit/rest";
import { expect, test, vi } from "vitest";

import {
	createIssueComment,
	fetchIssueDependenciesBlockedBy,
	GitHubIssueCommentError,
	GitHubIssueFetchError,
} from "@/lib/github/issues";

type ListDependenciesBlockedByResponse = Awaited<
	ReturnType<Octokit["rest"]["issues"]["listDependenciesBlockedBy"]>
>;
type ListDependenciesBlockedByDependency =
	ListDependenciesBlockedByResponse["data"][number];
type CreateIssueCommentResponse = Awaited<
	ReturnType<Octokit["rest"]["issues"]["createComment"]>
>;
type ListDependenciesBlockedByMock = ReturnType<typeof vi.fn>;
type CreateIssueCommentMock = ReturnType<typeof vi.fn>;
type MockOctokit = {
	rest: {
		issues: {
			listDependenciesBlockedBy: ListDependenciesBlockedByMock;
			createComment: CreateIssueCommentMock;
		};
	};
};

const createOctokitMock = () => ({
	rest: {
		issues: {
			listDependenciesBlockedBy: vi.fn(),
			createComment: vi.fn(),
		},
	},
});

test("fetchIssueDependenciesBlockedBy returns normalized issue dependencies from Octokit", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const listDependenciesBlockedBy = octokit.rest.issues
		.listDependenciesBlockedBy as ListDependenciesBlockedByMock;

	const dependency = {
		id: 1,
		node_id: "MDU6SXNzdWUx",
		number: 7,
		title: "Blocker",
		html_url: "https://github.com/octo/org/issues/7",
		state: "open",
		repository_url: "https://api.github.com/repos/octo/rhapsody",
		url: "https://api.github.com/repos/octo/rhapsody/issues/7",
		labels_url:
			"https://api.github.com/repos/octo/rhapsody/issues/7/labels{/name}",
		comments_url:
			"https://api.github.com/repos/octo/rhapsody/issues/7/comments",
		events_url: "https://api.github.com/repos/octo/rhapsody/issues/7/events",
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-02T00:00:00Z",
		closed_at: null,
		body: null,
		author_association: "NONE",
		labels: [],
		assignees: [],
		assignee: null,
		locked: false,
		milestone: null,
		reactions: {
			total_count: 0,
			"+1": 0,
			"-1": 0,
			confused: 0,
			eyes: 0,
			heart: 0,
			hooray: 0,
			rocket: 0,
			laugh: 0,
			url: "",
		},
		comments: 0,
		user: {
			login: "octo",
			id: 1,
			node_id: "nodeid",
			avatar_url: "",
			gravatar_id: "",
			url: "",
			html_url: "",
			followers_url: "",
			following_url: "",
			gists_url: "",
			starred_url: "",
			subscriptions_url: "",
			organizations_url: "",
			repos_url: "",
			events_url: "",
			received_events_url: "",
			type: "User",
			site_admin: false,
		},
	} satisfies ListDependenciesBlockedByDependency;

	const response: ListDependenciesBlockedByResponse = {
		data: [dependency],
		status: 200,
		headers: {},
		url: "",
	};
	listDependenciesBlockedBy.mockResolvedValue(response);

	const result = await fetchIssueDependenciesBlockedBy(
		{
			owner: "octo",
			repository: "rhapsody",
			issueNumber: 12,
		},
		{
			GITHUB_TOKEN: "test-token",
		},
		{
			octokit,
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

	expect(octokit.rest.issues.listDependenciesBlockedBy).toHaveBeenCalledWith({
		owner: "octo",
		repo: "rhapsody",
		issue_number: 12,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2026-03-10",
		},
	});

	expect(listDependenciesBlockedBy).toHaveBeenCalledTimes(1);
});

test("fetchIssueDependenciesBlockedBy fails when Octokit request rejects", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const listDependenciesBlockedBy = octokit.rest.issues
		.listDependenciesBlockedBy as ListDependenciesBlockedByMock;

	listDependenciesBlockedBy.mockRejectedValue(
		Object.assign(new Error("forbidden"), { status: 403 }),
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
			{
				octokit,
			},
		),
	).rejects.toBeInstanceOf(GitHubIssueFetchError);
});

test("createIssueComment creates comment via Octokit and returns normalized shape", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const createComment = octokit.rest.issues
		.createComment as CreateIssueCommentMock;

	const response = {
		data: {
			id: 123,
			html_url: "https://github.com/octo/rhapsody/issues/12#issuecomment-123",
			url: "https://api.github.com/repos/octo/rhapsody/issues/comments/123",
			node_id: "MDEyOklzc3VlQ29tbWVudDEyMw==",
			body: "Hello",
			body_text: "Hello",
			body_html: "<p>Hello</p>",
			issue_url: "https://api.github.com/repos/octo/rhapsody/issues/12",
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
			author_association: "NONE",
			user: {
				login: "octo",
				id: 1,
				node_id: "MDQ6VXNlcjE=",
				avatar_url: "",
				gravatar_id: "",
				url: "https://api.github.com/users/octo",
				html_url: "https://github.com/octo",
				followers_url: "https://api.github.com/users/octo/followers",
				following_url:
					"https://api.github.com/users/octo/following{/other_user}",
				gists_url: "https://api.github.com/users/octo/gists{/gist_id}",
				starred_url: "https://api.github.com/users/octo/starred{/owner}{/repo}",
				subscriptions_url: "https://api.github.com/users/octo/subscriptions",
				organizations_url: "https://api.github.com/users/octo/orgs",
				repos_url: "https://api.github.com/users/octo/repos",
				events_url: "https://api.github.com/users/octo/events{/privacy}",
				received_events_url:
					"https://api.github.com/users/octo/received_events",
				type: "User",
				site_admin: false,
			},
		},
		status: 201,
		headers: {},
		url: "",
	} satisfies CreateIssueCommentResponse;
	createComment.mockResolvedValue(response);

	const result = await createIssueComment(
		{
			owner: "octo",
			repository: "rhapsody",
			issueNumber: 12,
			body: "Hello",
		},
		{
			GITHUB_TOKEN: "test-token",
		},
		{
			octokit,
		},
	);

	expect(result).toEqual({
		id: 123,
		htmlUrl: "https://github.com/octo/rhapsody/issues/12#issuecomment-123",
	});

	expect(createComment).toHaveBeenCalledWith({
		owner: "octo",
		repo: "rhapsody",
		issue_number: 12,
		body: "Hello",
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
});

test("createIssueComment fails when Octokit request rejects", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const createComment = octokit.rest.issues
		.createComment as CreateIssueCommentMock;

	createComment.mockRejectedValue(
		Object.assign(new Error("forbidden"), { status: 403 }),
	);

	await expect(
		createIssueComment(
			{
				owner: "octo",
				repository: "rhapsody",
				issueNumber: 12,
				body: "Hello",
			},
			{
				GITHUB_TOKEN: "test-token",
			},
			{
				octokit,
			},
		),
	).rejects.toBeInstanceOf(GitHubIssueCommentError);
});
