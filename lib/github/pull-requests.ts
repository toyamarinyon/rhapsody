import { Octokit } from "@octokit/rest";

import { loadRhapsodyGitHubEnv, type RhapsodyGitHubEnv } from "@/lib/config";

export type PullRequestSummary = {
	reused: boolean;
	number: number;
	htmlUrl: string;
	headRef: string;
	baseRef: string;
	title: string;
	state: "open" | "closed";
	merged: boolean;
	mergedAt: string | null;
	sha?: string | null;
};

export type PullRequestMergeResult = {
	number: number;
	merged: boolean;
	message: string;
	sha: string | null;
};

type GetPullRequestFn = Octokit["rest"]["pulls"]["get"];
type ListOpenPullsFn = Octokit["rest"]["pulls"]["list"];
type ListPullFilesFn = Octokit["rest"]["pulls"]["listFiles"];
type CreatePullRequestFn = Octokit["rest"]["pulls"]["create"];
type MergePullRequestFn = Octokit["rest"]["pulls"]["merge"];
type GetPullRequestResponse = Awaited<ReturnType<GetPullRequestFn>>;
type ListOpenPullsResponse = Awaited<ReturnType<ListOpenPullsFn>>;
type ListOpenPullsResponseData = ListOpenPullsResponse["data"];
type CreatePullRequestResponse = Awaited<ReturnType<CreatePullRequestFn>>;
type MergePullRequestResponse = Awaited<ReturnType<MergePullRequestFn>>;

type OctokitPullRequestClient = {
	rest: {
		pulls: {
			get: (
				...args: Parameters<GetPullRequestFn>
			) => ReturnType<GetPullRequestFn>;
			list: (
				...args: Parameters<ListOpenPullsFn>
			) => ReturnType<ListOpenPullsFn>;
			listFiles: (
				...args: Parameters<ListPullFilesFn>
			) => ReturnType<ListPullFilesFn>;
			create: (
				...args: Parameters<CreatePullRequestFn>
			) => ReturnType<CreatePullRequestFn>;
			merge: (
				...args: Parameters<MergePullRequestFn>
			) => ReturnType<MergePullRequestFn>;
		};
	};
};

export class GitHubPullRequestError extends Error {
	constructor(
		readonly status: number,
		readonly owner: string,
		readonly repository: string,
		readonly action: string,
		readonly messageText: string,
	) {
		super(
			`GitHub pull request ${action} failed for ${owner}/${repository} (${status}): ${messageText}`,
		);
		this.name = "GitHubPullRequestError";
	}
}

export async function createOrReuseOpenPullRequest(
	input: {
		owner: string;
		repository: string;
		head: string;
		base: string;
		title: string;
		body: string;
	},
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
	options?: {
		octokit?: OctokitPullRequestClient;
	},
): Promise<PullRequestSummary> {
	const existing = await findOpenPullRequestForHead({
		env,
		owner: input.owner,
		repository: input.repository,
		head: input.head,
		base: input.base,
		options,
	});

	if (existing) {
		return {
			reused: true,
			...existing,
		};
	}

	let created: Awaited<ReturnType<typeof createPullRequest>>;
	try {
		created = await createPullRequest({
			env,
			owner: input.owner,
			repository: input.repository,
			title: input.title,
			body: input.body,
			head: input.head,
			base: input.base,
			options,
		});
	} catch (error) {
		if (
			!(error instanceof GitHubPullRequestError) ||
			![409, 422].includes(error.status)
		) {
			throw error;
		}

		const racedExisting = await findOpenPullRequestForHead({
			env,
			owner: input.owner,
			repository: input.repository,
			head: input.head,
			base: input.base,
			options,
		});

		if (racedExisting) {
			return {
				reused: true,
				...racedExisting,
			};
		}

		throw error;
	}

	return {
		reused: false,
		...created,
	};
}

export async function getPullRequest(
	input: {
		owner: string;
		repository: string;
		pullRequestNumber: number;
	},
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
	options?: {
		octokit?: OctokitPullRequestClient;
	},
): Promise<PullRequestSummary> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });
	let response: GetPullRequestResponse;
	try {
		response = await octokit.rest.pulls.get({
			owner: input.owner,
			repo: input.repository,
			pull_number: input.pullRequestNumber,
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	} catch (error) {
		const status = getErrorStatus(error);
		throw new GitHubPullRequestError(
			status,
			input.owner,
			input.repository,
			"lookup",
			error instanceof Error ? error.message : "request failed",
		);
	}

	const payload = response.data;
	return {
		reused: true,
		number: payload.number,
		htmlUrl: payload.html_url,
		title: payload.title,
		headRef: payload.head.ref,
		baseRef: payload.base.ref,
		state: normalizePullRequestState(payload.state),
		merged: payload.merged,
		mergedAt: payload.merged_at,
		sha: payload.merge_commit_sha ?? payload.head.sha ?? null,
	};
}

export async function getPullRequestChangedFiles(
	input: {
		owner: string;
		repository: string;
		pullRequestNumber: number;
	},
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
	options?: {
		octokit?: OctokitPullRequestClient;
	},
): Promise<string[]> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });

	const perPage = 100;
	const filenames: string[] = [];
	let page = 1;
	try {
		while (true) {
			const response = await octokit.rest.pulls.listFiles({
				owner: input.owner,
				repo: input.repository,
				pull_number: input.pullRequestNumber,
				per_page: perPage,
				page,
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			const payload = response.data;
			for (const file of payload) {
				filenames.push(file.filename);
			}

			const linkHeader = response.headers.link;
			if (
				payload.length < perPage ||
				!linkHeader ||
				!linkHeader.includes('rel="next"')
			) {
				return filenames;
			}

			page += 1;
		}
	} catch (error) {
		const status = getErrorStatus(error);
		throw new GitHubPullRequestError(
			status,
			input.owner,
			input.repository,
			"list_files",
			error instanceof Error ? error.message : "request failed",
		);
	}
	return filenames;
}

export async function mergePullRequest(
	input: {
		owner: string;
		repository: string;
		pullRequestNumber: number;
		mergeMethod?: "merge" | "squash" | "rebase";
		commitTitle?: string;
	},
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
	options?: {
		octokit?: OctokitPullRequestClient;
	},
): Promise<PullRequestMergeResult> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });
	let response: MergePullRequestResponse;
	try {
		response = await octokit.rest.pulls.merge({
			owner: input.owner,
			repo: input.repository,
			pull_number: input.pullRequestNumber,
			merge_method: input.mergeMethod ?? "squash",
			commit_title: input.commitTitle,
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	} catch (error) {
		const status = getErrorStatus(error);
		throw new GitHubPullRequestError(
			status,
			input.owner,
			input.repository,
			"merge",
			error instanceof Error ? error.message : "request failed",
		);
	}

	const payload = response.data;

	return {
		number: input.pullRequestNumber,
		merged: payload.merged,
		message: payload.message,
		sha: payload.sha,
	};
}

async function findOpenPullRequestForHead({
	env,
	owner,
	repository,
	head,
	base,
	options,
}: {
	env: RhapsodyGitHubEnv;
	owner: string;
	repository: string;
	head: string;
	base: string;
	options?: {
		octokit?: OctokitPullRequestClient;
	};
}): Promise<{
	number: number;
	htmlUrl: string;
	title: string;
	headRef: string;
	baseRef: string;
	state: "open" | "closed";
	merged: boolean;
	mergedAt: string | null;
} | null> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });
	const perPage = 100;
	let page = 1;
	let pulls: ListOpenPullsResponseData = [];
	try {
		while (true) {
			const response = await octokit.rest.pulls.list({
				owner,
				repo: repository,
				state: "open",
				head: `${owner}:${head}`,
				per_page: perPage,
				page,
				headers: {
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});

			pulls = [...pulls, ...response.data];

			if (response.data.length < perPage) {
				break;
			}

			const linkHeader = response.headers.link;
			if (!linkHeader?.includes('rel="next"')) {
				break;
			}

			page += 1;
		}
	} catch (error) {
		const status = getErrorStatus(error);
		throw new GitHubPullRequestError(
			status,
			owner,
			repository,
			"lookup",
			error instanceof Error ? error.message : "request failed",
		);
	}

	if (pulls.length === 0) {
		return null;
	}

	const candidate = pulls.find((pull) => pull.base.ref === base);
	if (!candidate) {
		return null;
	}

	return {
		number: candidate.number,
		htmlUrl: candidate.html_url,
		title: candidate.title,
		headRef: candidate.head.ref,
		baseRef: candidate.base.ref,
		state: normalizePullRequestState(candidate.state),
		merged: candidate.merged_at !== null,
		mergedAt: candidate.merged_at,
	};
}

async function createPullRequest(args: {
	env: RhapsodyGitHubEnv;
	owner: string;
	repository: string;
	title: string;
	body: string;
	head: string;
	base: string;
	options?: {
		octokit?: OctokitPullRequestClient;
	};
}): Promise<{
	number: number;
	htmlUrl: string;
	title: string;
	headRef: string;
	baseRef: string;
	state: "open" | "closed";
	merged: boolean;
	mergedAt: string | null;
}> {
	const octokit =
		args.options?.octokit ?? new Octokit({ auth: args.env.GITHUB_TOKEN });
	let response: CreatePullRequestResponse;
	try {
		response = await octokit.rest.pulls.create({
			owner: args.owner,
			repo: args.repository,
			title: args.title,
			body: args.body,
			head: args.head,
			base: args.base,
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	} catch (error) {
		const status = getErrorStatus(error);
		throw new GitHubPullRequestError(
			status,
			args.owner,
			args.repository,
			"create",
			error instanceof Error ? error.message : "request failed",
		);
	}

	const created = response.data;
	return {
		number: created.number,
		htmlUrl: created.html_url,
		title: created.title,
		headRef: created.head.ref,
		baseRef: created.base.ref,
		state: normalizePullRequestState(created.state),
		merged: created.merged,
		mergedAt: created.merged_at,
	};
}

function normalizePullRequestState(state: string): "open" | "closed" {
	return state === "closed" ? "closed" : "open";
}

function getErrorStatus(value: unknown): number {
	if (
		typeof value === "object" &&
		value !== null &&
		"status" in value &&
		typeof (value as { status?: unknown }).status === "number"
	) {
		return (value as { status: number }).status;
	}

	return 500;
}
