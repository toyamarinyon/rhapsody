import { Octokit } from "@octokit/rest";

import { loadRhapsodyGitHubEnv, type RhapsodyGitHubEnv } from "@/lib/config";

export type GitHubIssueLabel = {
	id: number;
	nodeId: string;
	name: string;
	color: string | null;
	description: string | null;
};

export type GitHubIssue = {
	number: number;
	id: number;
	nodeId: string;
	title: string;
	body: string | null;
	htmlUrl: string;
	state: string;
	labels: GitHubIssueLabel[];
};

export type GitHubBlockedByDependency = {
	id: string;
	nodeId: string;
	number: number;
	title: string;
	htmlUrl: string;
	state: string;
	repositoryUrl: string;
	repository: {
		owner: string;
		name: string;
	};
};

export type GitHubIssueComment = {
	id: number;
	body: string;
	htmlUrl: string;
	createdAt: string;
	updatedAt: string;
	authorLogin: string | null;
};

type ListCommentsFn = Octokit["rest"]["issues"]["listComments"];
type ListCommentsResponse = Awaited<ReturnType<ListCommentsFn>>;
type ListCommentsResult = ListCommentsResponse["data"][number];
type ListDependenciesBlockedByFn =
	Octokit["rest"]["issues"]["listDependenciesBlockedBy"];
type ListDependenciesBlockedByResponse = Awaited<
	ReturnType<ListDependenciesBlockedByFn>
>;
type ListDependenciesBlockedByDependency =
	ListDependenciesBlockedByResponse["data"][number];
type CreateIssueCommentFn = Octokit["rest"]["issues"]["createComment"];
type CreateIssueCommentResponse = Awaited<ReturnType<CreateIssueCommentFn>>;
type GetIssueFn = Octokit["rest"]["issues"]["get"];
type GetIssueResponse = Awaited<ReturnType<GetIssueFn>>;
type GetIssueLabel = GetIssueResponse["data"]["labels"][number];
type GetIssueLabelObject = Exclude<GetIssueLabel, string>;
type CreateIssueCommentError = Error & {
	status?: number;
};
type GetIssueError = Error & {
	status?: number;
};
type OctokitIssueDependenciesClient = {
	rest: {
		issues: {
			listDependenciesBlockedBy: (
				...args: Parameters<ListDependenciesBlockedByFn>
			) => ReturnType<ListDependenciesBlockedByFn>;
			get: (...args: Parameters<GetIssueFn>) => ReturnType<GetIssueFn>;
		};
	};
};
type OctokitIssueCommentsClient = {
	rest: {
		issues: {
			listComments: (
				...args: Parameters<ListCommentsFn>
			) => ReturnType<ListCommentsFn>;
		};
	};
};

export class GitHubIssueFetchError extends Error {
	constructor(
		readonly status: number,
		readonly owner: string,
		readonly repository: string,
		readonly issueNumber: number,
		readonly resource: string = "issue",
	) {
		super(
			`GitHub ${resource} fetch failed with status ${status} for ${owner}/${repository}#${issueNumber}.`,
		);
		this.name = "GitHubIssueFetchError";
	}
}

export class GitHubIssueCommentError extends Error {
	constructor(
		readonly status: number,
		readonly owner: string,
		readonly repository: string,
		readonly issueNumber: number,
		readonly messageText: string,
	) {
		super(
			`GitHub issue comment failed for ${owner}/${repository}#${issueNumber}: ${messageText}`,
		);
		this.name = "GitHubIssueCommentError";
	}
}

export async function fetchGitHubIssue(
	input: { owner: string; repository: string; issueNumber: number },
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
	options?: {
		octokit?: OctokitIssueDependenciesClient;
	},
): Promise<GitHubIssue> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });
	let response: GetIssueResponse;
	try {
		response = await octokit.rest.issues.get({
			owner: input.owner,
			repo: input.repository,
			issue_number: input.issueNumber,
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	} catch (error) {
		const typedError = error as GetIssueError;
		const status =
			typeof typedError?.status === "number" ? typedError.status : 500;

		throw new GitHubIssueFetchError(
			status,
			input.owner,
			input.repository,
			input.issueNumber,
		);
	}

	return normalizeIssue(response.data);
}

export async function createIssueComment(
	input: {
		owner: string;
		repository: string;
		issueNumber: number;
		body: string;
	},
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
	options?: {
		octokit?: {
			rest: {
				issues: {
					createComment: (
						...args: Parameters<CreateIssueCommentFn>
					) => ReturnType<CreateIssueCommentFn>;
				};
			};
		};
	},
): Promise<{ id: number; htmlUrl: string }> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });
	let response: CreateIssueCommentResponse;
	try {
		response = await octokit.rest.issues.createComment({
			owner: input.owner,
			repo: input.repository,
			issue_number: input.issueNumber,
			body: input.body,
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	} catch (error) {
		const typedError = error as CreateIssueCommentError;
		const status =
			typeof typedError?.status === "number" ? typedError.status : 500;
		const message =
			typeof typedError?.message === "string"
				? typedError.message
				: "GitHub issue comment request failed.";

		throw new GitHubIssueCommentError(
			status,
			input.owner,
			input.repository,
			input.issueNumber,
			message,
		);
	}

	return {
		id: response.data.id,
		htmlUrl: response.data.html_url,
	};
}

export async function fetchIssueDependenciesBlockedBy(
	input: { owner: string; repository: string; issueNumber: number },
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
	options?: {
		octokit?: OctokitIssueDependenciesClient;
	},
): Promise<GitHubBlockedByDependency[]> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });
	let response: ListDependenciesBlockedByResponse;
	try {
		response = await octokit.rest.issues.listDependenciesBlockedBy({
			owner: input.owner,
			repo: input.repository,
			issue_number: input.issueNumber,
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2026-03-10",
			},
		});
	} catch (error) {
		const status =
			typeof error === "object" &&
			error !== null &&
			"status" in error &&
			typeof error.status === "number"
				? error.status
				: 500;

		throw new GitHubIssueFetchError(
			status,
			input.owner,
			input.repository,
			input.issueNumber,
			"issue dependencies endpoint",
		);
	}

	return response.data.map((dependency) =>
		normalizeBlockedByDependency(dependency),
	);
}

export async function fetchIssueComments(
	input: { owner: string; repository: string; issueNumber: number },
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
	options?: {
		octokit?: OctokitIssueCommentsClient;
	},
): Promise<GitHubIssueComment[]> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });
	const comments: ListCommentsResponse["data"] = [];
	try {
		let page = 1;
		let hasNext = true;

		while (hasNext) {
			const response = await octokit.rest.issues.listComments({
				owner: input.owner,
				repo: input.repository,
				issue_number: input.issueNumber,
				per_page: 100,
				page,
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			comments.push(...response.data);
			hasNext = response.headers.link?.includes('rel="next"') ?? false;
			page += 1;
		}
	} catch (error) {
		const typedError = error as GitHubIssueCommentError;
		const status =
			typeof typedError?.status === "number" ? typedError.status : 500;

		throw new GitHubIssueCommentError(
			status,
			input.owner,
			input.repository,
			input.issueNumber,
			"GitHub issue comments request failed.",
		);
	}

	return comments.map((comment) => normalizeIssueComment(comment));
}

function normalizeBlockedByDependency(
	dependency: ListDependenciesBlockedByDependency,
): GitHubBlockedByDependency {
	const repositoryUrl = dependency.repository_url;
	const [owner, name] = parseRepositoryOwnerAndNameFromUrl(repositoryUrl);

	return {
		id: `${dependency.id}`,
		nodeId: dependency.node_id,
		number: dependency.number,
		title: dependency.title,
		htmlUrl: dependency.html_url,
		repositoryUrl,
		state: dependency.state,
		repository: {
			owner,
			name,
		},
	};
}

function normalizeIssueComment(value: ListCommentsResult): GitHubIssueComment {
	return {
		id: value.id,
		body: value.body ?? "",
		htmlUrl: value.html_url,
		createdAt: value.created_at,
		updatedAt: value.updated_at,
		authorLogin: value.user?.login ?? null,
	};
}

function parseRepositoryOwnerAndNameFromUrl(url: string): [string, string] {
	try {
		const parsed = new URL(url);
		const parts = parsed.pathname.split("/");
		const repoIndex = parts.indexOf("repos");

		if (repoIndex >= 0 && parts[repoIndex + 1] && parts[repoIndex + 2]) {
			return [parts[repoIndex + 1], parts[repoIndex + 2]];
		}
	} catch {
		// Ignore invalid repository URL.
	}

	return ["", ""];
}

function normalizeIssue(value: GetIssueResponse["data"]): GitHubIssue {
	return {
		number: value.number,
		id: value.id,
		nodeId: value.node_id,
		title: value.title,
		body: value.body ?? null,
		htmlUrl: value.html_url,
		state: value.state,
		labels: value.labels.flatMap(normalizeLabel),
	};
}

function normalizeLabel(value: GetIssueLabel): GitHubIssueLabel[] {
	if (typeof value === "string") {
		return [];
	}

	const asLabel = value as GetIssueLabelObject;

	return [
		{
			id: asLabel.id ?? 0,
			nodeId: asLabel.node_id ?? "",
			name: asLabel.name ?? "",
			color: asLabel.color ?? null,
			description: asLabel.description ?? null,
		},
	];
}
