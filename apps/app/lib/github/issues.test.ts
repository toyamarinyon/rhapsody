import type { Octokit } from "@octokit/rest";
import { expect, test, vi } from "vitest";

import {
	createIssueComment,
	createIssueReaction,
	fetchGitHubIssue,
	fetchIssueComments,
	fetchIssueDependenciesBlockedBy,
	type GitHubIssueComment,
	GitHubIssueCommentError,
	GitHubIssueFetchError,
	GitHubIssueReactionError,
	updateIssueComment,
} from "@/lib/github/issues";

type ListDependenciesBlockedByResponse = Awaited<
	ReturnType<Octokit["rest"]["issues"]["listDependenciesBlockedBy"]>
>;
type ListDependenciesBlockedByDependency =
	ListDependenciesBlockedByResponse["data"][number];
type ListIssueCommentsResponse = Awaited<
	ReturnType<Octokit["rest"]["issues"]["listComments"]>
>;
type ListIssueCommentsComment = ListIssueCommentsResponse["data"][number];
type CreateIssueCommentResponse = Awaited<
	ReturnType<Octokit["rest"]["issues"]["createComment"]>
>;
type UpdateIssueCommentResponse = Awaited<
	ReturnType<Octokit["rest"]["issues"]["updateComment"]>
>;
type CreateIssueReactionResponse = Awaited<
	ReturnType<Octokit["rest"]["reactions"]["createForIssue"]>
>;
type ListDependenciesBlockedByMock = ReturnType<typeof vi.fn>;
type ListIssueCommentsMock = ReturnType<typeof vi.fn>;
type CreateIssueCommentMock = ReturnType<typeof vi.fn>;
type UpdateIssueCommentMock = ReturnType<typeof vi.fn>;
type CreateIssueReactionMock = ReturnType<typeof vi.fn>;
type GetIssueMock = ReturnType<typeof vi.fn>;
type MockOctokit = {
	rest: {
		issues: {
			listDependenciesBlockedBy: ListDependenciesBlockedByMock;
			listComments: ListIssueCommentsMock;
			createComment: CreateIssueCommentMock;
			updateComment: UpdateIssueCommentMock;
			get: GetIssueMock;
		};
		reactions: {
			createForIssue: CreateIssueReactionMock;
		};
	};
};

const createOctokitMock = () => ({
	rest: {
		issues: {
			listDependenciesBlockedBy: vi.fn(),
			listComments: vi.fn(),
			createComment: vi.fn(),
			updateComment: vi.fn(),
			get: vi.fn(),
		},
		reactions: {
			createForIssue: vi.fn(),
		},
	},
});

test("fetchGitHubIssue returns normalized issue from Octokit", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const get = octokit.rest.issues.get as GetIssueMock;

	const issue = {
		number: 12,
		id: 101,
		node_id: "MDU6SXNzdWUxMQ==",
		url: "https://api.github.com/repos/octo/rhapsody/issues/12",
		repository_url: "https://api.github.com/repos/octo/rhapsody",
		labels_url:
			"https://api.github.com/repos/octo/rhapsody/issues/12/labels{/name}",
		comments_url:
			"https://api.github.com/repos/octo/rhapsody/issues/12/comments",
		events_url: "https://api.github.com/repos/octo/rhapsody/issues/12/events",
		html_url: "https://github.com/octo/rhapsody/issues/12",
		title: "Issue title",
		body: "body",
		state: "open",
		labels: [
			{
				id: 1,
				node_id: "MDU6TGFiZWwx",
				name: "bug",
				color: "ff0000",
				description: "fix",
			},
		],
		locked: false,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		closed_at: null,
		author_association: "NONE",
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
		comments: 0,
		pull_request: undefined,
		repository: {},
	};

	const response = {
		data: issue,
		status: 200,
		headers: {},
		url: "",
	};
	get.mockResolvedValue(response);

	const result = await fetchGitHubIssue(
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

	expect(result).toEqual({
		number: 12,
		id: 101,
		nodeId: "MDU6SXNzdWUxMQ==",
		title: "Issue title",
		body: "body",
		htmlUrl: "https://github.com/octo/rhapsody/issues/12",
		state: "open",
		labels: [
			{
				id: 1,
				nodeId: "MDU6TGFiZWwx",
				name: "bug",
				color: "ff0000",
				description: "fix",
			},
		],
	});

	expect(get).toHaveBeenCalledWith({
		owner: "octo",
		repo: "rhapsody",
		issue_number: 12,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
});

test("fetchGitHubIssue fails when Octokit request rejects", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const get = octokit.rest.issues.get as GetIssueMock;

	get.mockRejectedValue(Object.assign(new Error("not found"), { status: 404 }));

	await expect(
		fetchGitHubIssue(
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

test("fetchIssueComments returns normalized comments from Octokit", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const listComments = octokit.rest.issues
		.listComments as ListIssueCommentsMock;

	const response: ListIssueCommentsResponse = {
		data: [
			{
				id: 321,
				node_id: "MDEyOklzc3VlQ29tbWVudDI=",
				body: "Rhapsody needs more context",
				html_url: "https://github.com/octo/rhapsody/issues/12#issuecomment-321",
				issue_url: "https://api.github.com/repos/octo/rhapsody/issues/12",
				url: "https://api.github.com/repos/octo/rhapsody/issues/comments/321",
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T01:00:00Z",
				author_association: "CONTRIBUTOR",
				user: {
					login: "human",
					id: 2,
					node_id: "MDQ6VXNlcjI=",
					avatar_url: "",
					gravatar_id: "",
					url: "https://api.github.com/users/human",
					html_url: "https://github.com/human",
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
			} satisfies ListIssueCommentsComment,
		],
		status: 200,
		headers: {},
		url: "",
	};
	listComments.mockResolvedValue(response);

	const result = await fetchIssueComments(
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

	expect(result).toEqual<GitHubIssueComment[]>([
		{
			id: 321,
			body: "Rhapsody needs more context",
			htmlUrl: "https://github.com/octo/rhapsody/issues/12#issuecomment-321",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T01:00:00Z",
			authorLogin: "human",
		},
	]);

	expect(listComments).toHaveBeenCalledWith({
		owner: "octo",
		repo: "rhapsody",
		issue_number: 12,
		per_page: 100,
		page: 1,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
});

test("fetchIssueComments returns normalized comments from multiple pages", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const listComments = octokit.rest.issues
		.listComments as ListIssueCommentsMock;

	const firstPage: ListIssueCommentsResponse = {
		data: [
			{
				id: 321,
				node_id: "MDEyOklzc3VlQ29tbWVudDI=",
				body: "Rhapsody needs more context",
				html_url: "https://github.com/octo/rhapsody/issues/12#issuecomment-321",
				issue_url: "https://api.github.com/repos/octo/rhapsody/issues/12",
				url: "https://api.github.com/repos/octo/rhapsody/issues/comments/321",
				created_at: "2026-01-01T00:00:00Z",
				updated_at: "2026-01-01T01:00:00Z",
				author_association: "CONTRIBUTOR",
				user: {
					login: "human",
					id: 2,
					node_id: "MDQ6VXNlcjI=",
					avatar_url: "",
					gravatar_id: "",
					url: "https://api.github.com/users/human",
					html_url: "https://github.com/human",
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
			} satisfies ListIssueCommentsComment,
		],
		status: 200,
		headers: {
			link: '<https://api.github.com/repos/octo/rhapsody/issues/12/comments?page=2>; rel="next"',
		},
		url: "",
	};
	const secondPage: ListIssueCommentsResponse = {
		data: [
			{
				id: 322,
				node_id: "MDEyOklzc3VlQ29tbWVudDMyMg==",
				body: "Follow-up: please include logs",
				html_url: "https://github.com/octo/rhapsody/issues/12#issuecomment-322",
				issue_url: "https://api.github.com/repos/octo/rhapsody/issues/12",
				url: "https://api.github.com/repos/octo/rhapsody/issues/comments/322",
				created_at: "2026-01-02T00:00:00Z",
				updated_at: "2026-01-02T01:00:00Z",
				author_association: "CONTRIBUTOR",
				user: {
					login: "human",
					id: 2,
					node_id: "MDQ6VXNlcjI=",
					avatar_url: "",
					gravatar_id: "",
					url: "https://api.github.com/users/human",
					html_url: "https://github.com/human",
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
			} satisfies ListIssueCommentsComment,
		],
		status: 200,
		headers: {},
		url: "",
	};
	listComments
		.mockResolvedValueOnce(firstPage)
		.mockResolvedValueOnce(secondPage);

	const result = await fetchIssueComments(
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

	expect(result).toEqual<GitHubIssueComment[]>([
		{
			id: 321,
			body: "Rhapsody needs more context",
			htmlUrl: "https://github.com/octo/rhapsody/issues/12#issuecomment-321",
			createdAt: "2026-01-01T00:00:00Z",
			updatedAt: "2026-01-01T01:00:00Z",
			authorLogin: "human",
		},
		{
			id: 322,
			body: "Follow-up: please include logs",
			htmlUrl: "https://github.com/octo/rhapsody/issues/12#issuecomment-322",
			createdAt: "2026-01-02T00:00:00Z",
			updatedAt: "2026-01-02T01:00:00Z",
			authorLogin: "human",
		},
	]);

	expect(listComments).toHaveBeenCalledTimes(2);
	expect(listComments).toHaveBeenNthCalledWith(1, {
		owner: "octo",
		repo: "rhapsody",
		issue_number: 12,
		per_page: 100,
		page: 1,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	expect(listComments).toHaveBeenNthCalledWith(2, {
		owner: "octo",
		repo: "rhapsody",
		issue_number: 12,
		per_page: 100,
		page: 2,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
});

test("createIssueReaction returns normalized eyes reaction from Octokit", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const createForIssue = octokit.rest.reactions
		.createForIssue as CreateIssueReactionMock;

	const response: CreateIssueReactionResponse = {
		data: {
			id: 987,
			content: "eyes",
		} as CreateIssueReactionResponse["data"],
		status: 201,
		headers: {},
		url: "",
	};
	createForIssue.mockResolvedValue(response);

	const result = await createIssueReaction(
		{
			owner: "octo",
			repository: "rhapsody",
			issueNumber: 12,
			content: "eyes",
		},
		{
			GITHUB_TOKEN: "test-token",
		},
		{
			octokit,
		},
	);

	expect(result).toEqual({ id: 987, content: "eyes" });
	expect(createForIssue).toHaveBeenCalledWith({
		owner: "octo",
		repo: "rhapsody",
		issue_number: 12,
		content: "eyes",
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
});

test("createIssueReaction fails when Octokit request rejects", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const createForIssue = octokit.rest.reactions
		.createForIssue as CreateIssueReactionMock;

	createForIssue.mockRejectedValue(
		Object.assign(new Error("forbidden"), { status: 403 }),
	);

	await expect(
		createIssueReaction(
			{
				owner: "octo",
				repository: "rhapsody",
				issueNumber: 12,
				content: "eyes",
			},
			{
				GITHUB_TOKEN: "test-token",
			},
			{
				octokit,
			},
		),
	).rejects.toBeInstanceOf(GitHubIssueReactionError);
});

test("fetchIssueComments fails when Octokit request rejects", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const listComments = octokit.rest.issues
		.listComments as ListIssueCommentsMock;

	listComments.mockRejectedValue(
		Object.assign(new Error("unauthorized"), { status: 401 }),
	);

	await expect(
		fetchIssueComments(
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
	).rejects.toBeInstanceOf(GitHubIssueCommentError);
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

test("updateIssueComment updates comment via Octokit and returns normalized shape", async () => {
	const octokit = createOctokitMock() as MockOctokit;
	const updateComment = octokit.rest.issues
		.updateComment as UpdateIssueCommentMock;

	const response: UpdateIssueCommentResponse = {
		data: {
			id: 456,
			html_url: "https://github.com/octo/rhapsody/issues/12#issuecomment-456",
			url: "https://api.github.com/repos/octo/rhapsody/issues/comments/456",
			node_id: "MDEyOklzc3VlQ29tbWVudDQ1Ng==",
			body: "Updated",
			body_text: "Updated",
			body_html: "<p>Updated</p>",
			issue_url: "https://api.github.com/repos/octo/rhapsody/issues/12",
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-02T00:00:00Z",
			author_association: "NONE",
			user: null,
		},
		status: 200,
		headers: {},
		url: "",
	};
	updateComment.mockResolvedValue(response);

	const result = await updateIssueComment(
		{
			owner: "octo",
			repository: "rhapsody",
			commentId: 456,
			body: "Updated",
		},
		{
			GITHUB_TOKEN: "test-token",
		},
		{
			octokit,
		},
	);

	expect(result).toEqual({
		id: 456,
		htmlUrl: "https://github.com/octo/rhapsody/issues/12#issuecomment-456",
	});
	expect(updateComment).toHaveBeenCalledWith({
		owner: "octo",
		repo: "rhapsody",
		comment_id: 456,
		body: "Updated",
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
