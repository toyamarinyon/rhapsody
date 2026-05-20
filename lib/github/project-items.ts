import { loadRhapsodyGitHubEnv, type RhapsodyGitHubEnv } from "@/lib/config";

export type GitHubProjectIssueWorkItem = {
	issueNumber: number;
	issueTitle: string;
	issueUrl: string;
	issueState: string;
	issueBody: string | null;
	projectStatus: string | null;
	repository: {
		owner: string;
		name: string;
	};
};

type GitHubProjectIssueQueryOptions = {
	owner: string;
	repository: string;
	projectNumber: number;
	statusField: string;
};

type GitHubProjectItemsPage = {
	items: GitHubProjectIssueWorkItem[];
	hasNextPage: boolean;
	endCursor: string | null;
};

type GitHubProjectItemsGraphQLResponse = {
	data?: {
		user?: {
			projectV2?: {
				items?: {
					nodes?: GitHubProjectItemNode[] | null;
					pageInfo?: {
						hasNextPage?: boolean;
						endCursor?: string | null;
					} | null;
				} | null;
			} | null;
		} | null;
	} | null;
	errors?: Array<{ message?: unknown }>;
};

type GitHubProjectItemNode = {
	content?: GitHubProjectItemContent | null;
	fieldValues?: {
		nodes?: GitHubProjectItemFieldValueNode[] | null;
	} | null;
};

type GitHubProjectItemContent = {
	__typename?: string;
	number?: unknown;
	title?: unknown;
	url?: unknown;
	state?: unknown;
	body?: unknown;
	repository?: {
		name?: unknown;
		owner?: {
			login?: unknown;
		} | null;
	} | null;
};

type GitHubProjectItemFieldValueNode = {
	__typename?: string;
	name?: unknown;
	text?: unknown;
	field?: {
		name?: unknown;
	} | null;
	[key: string]: unknown;
};

export async function fetchProjectIssueWorkItems(
	options: GitHubProjectIssueQueryOptions,
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
): Promise<GitHubProjectIssueWorkItem[]> {
	// MVP: this reads from user-owned ProjectV2 objects.
	// TODO(owners): add a small owner-kind abstraction for org-owned trackers when needed.
	const allItems: GitHubProjectIssueWorkItem[] = [];
	let after: string | null = null;
	const normalizedStatusField = options.statusField.trim();

	while (true) {
		const page = await fetchProjectIssueWorkItemsPage({
			env,
			owner: options.owner,
			projectNumber: options.projectNumber,
			after,
			statusField: normalizedStatusField,
		});

		for (const item of page.items) {
			const matchesRepository =
				item.repository.owner === options.owner && item.repository.name === options.repository;
			if (!matchesRepository) {
				continue;
			}

			allItems.push(item);
		}

		if (!page.hasNextPage || !page.endCursor) {
			break;
		}

		after = page.endCursor;
	}

	return allItems;
}

async function fetchProjectIssueWorkItemsPage(input: {
	env: RhapsodyGitHubEnv;
	owner: string;
	projectNumber: number;
	statusField: string;
	after: string | null;
}): Promise<GitHubProjectItemsPage> {
	const response = await fetch("https://api.github.com/graphql", {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${input.env.GITHUB_TOKEN}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			query: GITHUB_PROJECT_ITEMS_QUERY,
			variables: {
				owner: input.owner,
				projectNumber: input.projectNumber,
				after: input.after,
			},
		}),
	});

	if (!response.ok) {
		throw new Error(`GitHub GraphQL request failed with status ${response.status}.`);
	}

	const payload = (await response.json()) as GitHubProjectItemsGraphQLResponse;

	if (!payload || (Array.isArray(payload.errors) && payload.errors.length > 0)) {
		throw new Error(
			`GitHub GraphQL request returned errors: ${JSON.stringify(payload.errors?.map((error) => error.message))}`,
		);
	}

	const itemsNode = payload.data?.user?.projectV2?.items;
	const nodes = itemsNode?.nodes;
	const pageInfo = itemsNode?.pageInfo;

	if (!Array.isArray(nodes) || !pageInfo) {
		throw new Error("GitHub GraphQL response had unexpected shape.");
	}

	const normalizedItems = nodes.flatMap((node) => normalizeProjectIssueWorkItem(node, input.statusField));

	return {
		items: normalizedItems,
		hasNextPage: pageInfo.hasNextPage ?? false,
		endCursor: pageInfo.endCursor ?? null,
	};
}

function normalizeProjectIssueWorkItem(
	node: GitHubProjectItemNode,
	statusField: string,
): GitHubProjectIssueWorkItem[] {
	if (!isGitHubIssueNode(node)) {
		return [];
	}

	const content = node.content;
	const repositoryOwner = safeString(content.repository?.owner?.login);
	const repositoryName = safeString(content.repository?.name);

	if (!repositoryOwner || !repositoryName) {
		return [];
	}

	const issueNumber = safeNumber(content.number);
	const issueTitle = safeString(content.title);
	const issueUrl = safeString(content.url);
	const issueState = safeString(content.state);
	const issueBody = content.body === null || typeof content.body === "string" ? content.body : null;
	const projectStatus = extractProjectStatus(node.fieldValues?.nodes, statusField);

	if (issueNumber === null || !issueTitle || !issueUrl || !issueState) {
		return [];
	}

	return [
		{
			issueNumber,
			issueTitle,
			issueUrl,
			issueState,
			issueBody,
			projectStatus,
			repository: {
				owner: repositoryOwner,
				name: repositoryName,
			},
		},
	];
}

function extractProjectStatus(
	values: GitHubProjectItemFieldValueNode[] | null | undefined,
	statusField: string,
): string | null {
	if (!Array.isArray(values)) {
		return null;
	}

	const targetField = safeString(statusField);

	if (!targetField) {
		return null;
	}

	for (const value of values) {
		if (typeof value !== "object" || value === null || !value.field || typeof value.field !== "object") {
			continue;
		}

		const valueField = safeString(value.field.name);
		if (!valueField || valueField !== targetField) {
			continue;
		}

		if (value.__typename === "ProjectV2ItemFieldSingleSelectValue") {
			const status = safeString(value.name);
			if (status) {
				return status;
			}
		}

		if (value.__typename === "ProjectV2ItemFieldTextValue") {
			const status = safeString(value.text);
			if (status) {
				return status;
			}
		}
	}

	return null;
}

function isGitHubIssueNode(node: unknown): node is GitHubProjectItemNode & { content: GitHubProjectItemContent } {
	if (
		typeof node !== "object" ||
		node === null ||
		typeof (node as { content?: unknown }).content !== "object" ||
		(node as { content?: unknown }).content === null
	) {
		return false;
	}

	const content = (node as { content: GitHubProjectItemContent }).content;
	return content.__typename === "Issue";
}

function safeString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function safeNumber(value: unknown): number | null {
	return typeof value === "number" && Number.isInteger(value) ? value : null;
}

const GITHUB_PROJECT_ITEMS_QUERY = `
	query FetchProjectIssueWorkItems(
		$owner: String!,
		$projectNumber: Int!,
		$after: String
	) {
		user(login: $owner) {
			projectV2(number: $projectNumber) {
				items(first: 100, after: $after) {
					nodes {
						content {
							__typename
							... on Issue {
								number
								title
								body
								url
								state
								repository {
									name
									owner {
										login
									}
								}
							}
						}
						fieldValues(first: 20) {
							nodes {
								__typename
								... on ProjectV2ItemFieldTextValue {
									text
									field {
										... on ProjectV2FieldCommon {
											name
										}
									}
								}
								... on ProjectV2ItemFieldSingleSelectValue {
									name
									field {
										... on ProjectV2FieldCommon {
											name
										}
									}
								}
							}
						}
					}
					pageInfo {
						hasNextPage
						endCursor
					}
				}
			}
		}
	}
`;
