import { loadRhapsodyGitHubEnv, type RhapsodyGitHubEnv } from "@/lib/config";

export type PullRequestSummary = {
	reused: boolean;
	number: number;
	htmlUrl: string;
	headRef: string;
	baseRef: string;
	title: string;
};

export type PullRequestMergeResult = {
	number: number;
	merged: boolean;
	message: string;
	sha: string | null;
};

type GitHubApiPullRequest = {
	number: number;
	html_url: string;
	title: string;
	head: {
		ref: string;
	};
	base: {
		ref: string;
	};
};

type GitHubApiPullRequestMergeResponse = {
	sha: string | null;
	merged: boolean;
	message: string;
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
): Promise<PullRequestSummary> {
	const existing = await findOpenPullRequestForHead({
		env,
		owner: input.owner,
		repository: input.repository,
		head: input.head,
		base: input.base,
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

export async function mergePullRequest(
	input: {
		owner: string;
		repository: string;
		pullRequestNumber: number;
		mergeMethod?: "merge" | "squash" | "rebase";
		commitTitle?: string;
	},
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
): Promise<PullRequestMergeResult> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullRequestNumber}/merge`,
		{
			method: "PUT",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${env.GITHUB_TOKEN}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				merge_method: input.mergeMethod ?? "squash",
				commit_title: input.commitTitle,
			}),
		},
	);

	if (!response.ok) {
		const message = await safeResponseText(response);
		throw new GitHubPullRequestError(
			response.status,
			input.owner,
			input.repository,
			"merge",
			message,
		);
	}

	const payload = normalizePullRequestMergeResponse(await response.json());

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
}: {
	env: RhapsodyGitHubEnv;
	owner: string;
	repository: string;
	head: string;
	base: string;
}): Promise<{
	number: number;
	htmlUrl: string;
	title: string;
	headRef: string;
	baseRef: string;
} | null> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
			repository,
		)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${env.GITHUB_TOKEN}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);

	if (!response.ok) {
		const message = await safeResponseText(response);
		throw new GitHubPullRequestError(
			response.status,
			owner,
			repository,
			"lookup",
			message,
		);
	}

	const pulls = normalizePullRequestList(await response.json());

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
}): Promise<{
	number: number;
	htmlUrl: string;
	title: string;
	headRef: string;
	baseRef: string;
}> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repository)}/pulls`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${args.env.GITHUB_TOKEN}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"content-type": "application/json",
			},
			body: JSON.stringify({
				title: args.title,
				body: args.body,
				head: args.head,
				base: args.base,
			}),
		},
	);

	if (!response.ok) {
		const message = await safeResponseText(response);
		throw new GitHubPullRequestError(
			response.status,
			args.owner,
			args.repository,
			"create",
			message,
		);
	}

	const created = normalizePullRequest(await response.json());
	return {
		number: created.number,
		htmlUrl: created.html_url,
		title: created.title,
		headRef: created.head.ref,
		baseRef: created.base.ref,
	};
}

function normalizePullRequest(value: unknown): GitHubApiPullRequest {
	if (!isGitHubPullRequest(value)) {
		throw new Error("GitHub pull request response had an unexpected shape.");
	}

	return value;
}

function normalizePullRequestList(value: unknown): GitHubApiPullRequest[] {
	if (!Array.isArray(value)) {
		throw new Error(
			"GitHub pull request list response had an unexpected shape.",
		);
	}

	return value.flatMap((candidate) =>
		isGitHubPullRequest(candidate) ? [candidate] : [],
	);
}

function normalizePullRequestMergeResponse(
	value: unknown,
): GitHubApiPullRequestMergeResponse {
	if (!isGitHubPullRequestMergeResponse(value)) {
		throw new Error(
			"GitHub pull request merge response had an unexpected shape.",
		);
	}

	return value;
}

function isGitHubPullRequest(value: unknown): value is GitHubApiPullRequest {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const pr = value as Partial<GitHubApiPullRequest>;
	return (
		typeof pr.number === "number" &&
		typeof pr.html_url === "string" &&
		typeof pr.title === "string" &&
		typeof pr.head === "object" &&
		pr.head !== null &&
		typeof pr.head.ref === "string" &&
		typeof pr.base === "object" &&
		pr.base !== null &&
		typeof pr.base.ref === "string"
	);
}

function isGitHubPullRequestMergeResponse(
	value: unknown,
): value is GitHubApiPullRequestMergeResponse {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const merge = value as Partial<GitHubApiPullRequestMergeResponse>;
	return (
		(merge.sha === null || typeof merge.sha === "string") &&
		typeof merge.merged === "boolean" &&
		typeof merge.message === "string"
	);
}

async function safeResponseText(response: Response): Promise<string> {
	try {
		const text = await response.text();
		return text || `${response.status} ${response.statusText}`;
	} catch {
		return `${response.status} ${response.statusText}`;
	}
}
