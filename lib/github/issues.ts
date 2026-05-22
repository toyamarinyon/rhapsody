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

export class GitHubIssueFetchError extends Error {
	constructor(
		readonly status: number,
		readonly owner: string,
		readonly repository: string,
		readonly issueNumber: number,
	) {
		super(
			`GitHub issue fetch failed with status ${status} for ${owner}/${repository}#${issueNumber}.`,
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
): Promise<GitHubIssue> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(
			input.repository,
		)}/issues/${input.issueNumber}`,
		{
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${env.GITHUB_TOKEN}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		},
	);

	if (!response.ok) {
		throw new GitHubIssueFetchError(
			response.status,
			input.owner,
			input.repository,
			input.issueNumber,
		);
	}

	return normalizeIssue(await response.json());
}

export async function createIssueComment(
	input: {
		owner: string;
		repository: string;
		issueNumber: number;
		body: string;
	},
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
): Promise<{ id: number; htmlUrl: string }> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/issues/${input.issueNumber}/comments`,
		{
			method: "POST",
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${env.GITHUB_TOKEN}`,
				"X-GitHub-Api-Version": "2022-11-28",
				"content-type": "application/json",
			},
			body: JSON.stringify({ body: input.body }),
		},
	);

	if (!response.ok) {
		const message = await safeResponseText(response);
		throw new GitHubIssueCommentError(
			response.status,
			input.owner,
			input.repository,
			input.issueNumber,
			message,
		);
	}

	const payload = await response.json();

	if (
		typeof payload !== "object" ||
		payload === null ||
		typeof (payload as { id?: unknown }).id !== "number" ||
		typeof (payload as { html_url?: unknown }).html_url !== "string"
	) {
		throw new GitHubIssueCommentError(
			response.status,
			input.owner,
			input.repository,
			input.issueNumber,
			"GitHub issue comment response had unexpected shape.",
		);
	}

	return {
		id: (payload as { id: number }).id,
		htmlUrl: (payload as { html_url: string }).html_url,
	};
}

function normalizeIssue(value: unknown): GitHubIssue {
	if (!isGitHubIssueResponse(value)) {
		throw new Error("GitHub issue response had an unexpected shape.");
	}

	return {
		number: value.number,
		id: value.id,
		nodeId: value.node_id,
		title: value.title,
		body: value.body,
		htmlUrl: value.html_url,
		state: value.state,
		labels: value.labels.flatMap(normalizeLabel),
	};
}

function normalizeLabel(
	value: GitHubIssueResponse["labels"][number],
): GitHubIssueLabel[] {
	if (typeof value === "string") {
		return [];
	}

	return [
		{
			id: value.id,
			nodeId: value.node_id,
			name: value.name,
			color: value.color,
			description: value.description,
		},
	];
}

type GitHubIssueResponse = {
	number: number;
	id: number;
	node_id: string;
	title: string;
	body: string | null;
	html_url: string;
	state: string;
	labels: (
		| string
		| {
				id: number;
				node_id: string;
				name: string;
				color: string | null;
				description: string | null;
		  }
	)[];
};

function isGitHubIssueResponse(value: unknown): value is GitHubIssueResponse {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const issue = value as Partial<GitHubIssueResponse>;

	return (
		typeof issue.number === "number" &&
		typeof issue.id === "number" &&
		typeof issue.node_id === "string" &&
		typeof issue.title === "string" &&
		(issue.body === null || typeof issue.body === "string") &&
		typeof issue.html_url === "string" &&
		typeof issue.state === "string" &&
		Array.isArray(issue.labels)
	);
}

async function safeResponseText(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return `HTTP ${response.status}`;
	}
}
