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

export type GitHubProjectStatusUpdateResult = {
	projectId: string;
	itemId: string;
	fieldId: string;
	optionId: string;
	status: string;
};

type GitHubProjectIssueQueryOptions = {
	owner: string;
	repository: string;
	projectNumber: number;
	statusField: string;
};

type GitHubProjectStatusUpdateOptions = GitHubProjectIssueQueryOptions & {
	issueNumber: number;
	status: string;
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

type GitHubProjectStatusTargetGraphQLResponse = {
	data?: {
		user?: {
			projectV2?: {
				id?: unknown;
				fields?: {
					nodes?: GitHubProjectFieldNode[] | null;
				} | null;
				items?: {
					nodes?: GitHubProjectStatusItemNode[] | null;
				} | null;
			} | null;
		} | null;
	} | null;
	errors?: Array<{ message?: unknown }>;
};

type GitHubProjectStatusMutationResponse = {
	data?: {
		updateProjectV2ItemFieldValue?: {
			projectV2Item?: {
				id?: unknown;
			} | null;
		} | null;
	} | null;
	errors?: Array<{ message?: unknown }>;
};

type GitHubProjectFieldNode = {
	__typename?: string;
	id?: unknown;
	name?: unknown;
	options?: Array<{
		id?: unknown;
		name?: unknown;
	}> | null;
};

type GitHubProjectStatusItemNode = {
	id?: unknown;
	content?: GitHubProjectItemContent | null;
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
				item.repository.owner === options.owner &&
				item.repository.name === options.repository;
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

export async function updateProjectIssueStatus(
	options: GitHubProjectStatusUpdateOptions,
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
): Promise<GitHubProjectStatusUpdateResult> {
	const target = await fetchProjectIssueStatusTarget(options, env);

	await updateProjectV2ItemSingleSelect({
		env,
		projectId: target.projectId,
		itemId: target.itemId,
		fieldId: target.fieldId,
		optionId: target.optionId,
	});

	return {
		...target,
		status: options.status,
	};
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
		throw new Error(
			`GitHub GraphQL request failed with status ${response.status}.`,
		);
	}

	const payload = (await response.json()) as GitHubProjectItemsGraphQLResponse;

	if (
		!payload ||
		(Array.isArray(payload.errors) && payload.errors.length > 0)
	) {
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

	const normalizedItems = nodes.flatMap((node) =>
		normalizeProjectIssueWorkItem(node, input.statusField),
	);

	return {
		items: normalizedItems,
		hasNextPage: pageInfo.hasNextPage ?? false,
		endCursor: pageInfo.endCursor ?? null,
	};
}

async function fetchProjectIssueStatusTarget(
	options: GitHubProjectStatusUpdateOptions,
	env: RhapsodyGitHubEnv,
) {
	const response = await fetch("https://api.github.com/graphql", {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${env.GITHUB_TOKEN}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			query: GITHUB_PROJECT_STATUS_TARGET_QUERY,
			variables: {
				owner: options.owner,
				projectNumber: options.projectNumber,
			},
		}),
	});

	if (!response.ok) {
		throw new Error(
			`GitHub GraphQL project status target request failed with status ${response.status}.`,
		);
	}

	const payload =
		(await response.json()) as GitHubProjectStatusTargetGraphQLResponse;

	if (
		!payload ||
		(Array.isArray(payload.errors) && payload.errors.length > 0)
	) {
		throw new Error(
			`GitHub GraphQL project status target request returned errors: ${JSON.stringify(
				payload.errors?.map((error) => error.message),
			)}`,
		);
	}

	const project = payload.data?.user?.projectV2;
	const projectId = safeString(project?.id);
	const fields = project?.fields?.nodes;
	const items = project?.items?.nodes;

	if (!projectId || !Array.isArray(fields) || !Array.isArray(items)) {
		throw new Error(
			"GitHub GraphQL project status target response had unexpected shape.",
		);
	}

	const statusField = fields.find(
		(field) =>
			field.__typename === "ProjectV2SingleSelectField" &&
			safeString(field.name) === options.statusField,
	);
	const fieldId = safeString(statusField?.id);
	const option = statusField?.options?.find(
		(candidate) => safeString(candidate.name) === options.status,
	);
	const optionId = safeString(option?.id);

	if (!fieldId || !optionId) {
		throw new Error(
			`GitHub Project status option not found for ${options.statusField}=${options.status}.`,
		);
	}

	const item = items.find((candidate) =>
		isMatchingIssueProjectItem(candidate, options),
	);
	const itemId = safeString(item?.id);

	if (!itemId) {
		throw new Error(
			`GitHub Project item not found for ${options.owner}/${options.repository}#${options.issueNumber}.`,
		);
	}

	return {
		projectId,
		itemId,
		fieldId,
		optionId,
	};
}

async function updateProjectV2ItemSingleSelect(input: {
	env: RhapsodyGitHubEnv;
	projectId: string;
	itemId: string;
	fieldId: string;
	optionId: string;
}) {
	const response = await fetch("https://api.github.com/graphql", {
		method: "POST",
		headers: {
			Accept: "application/vnd.github+json",
			Authorization: `Bearer ${input.env.GITHUB_TOKEN}`,
			"X-GitHub-Api-Version": "2022-11-28",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			query: UPDATE_PROJECT_ITEM_SINGLE_SELECT_MUTATION,
			variables: {
				projectId: input.projectId,
				itemId: input.itemId,
				fieldId: input.fieldId,
				optionId: input.optionId,
			},
		}),
	});

	if (!response.ok) {
		throw new Error(
			`GitHub GraphQL project status update failed with status ${response.status}.`,
		);
	}

	const payload =
		(await response.json()) as GitHubProjectStatusMutationResponse;

	if (
		!payload ||
		(Array.isArray(payload.errors) && payload.errors.length > 0)
	) {
		throw new Error(
			`GitHub GraphQL project status update returned errors: ${JSON.stringify(
				payload.errors?.map((error) => error.message),
			)}`,
		);
	}
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
	const issueBody =
		content.body === null || typeof content.body === "string"
			? content.body
			: null;
	const projectStatus = extractProjectStatus(
		node.fieldValues?.nodes,
		statusField,
	);

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
		if (
			typeof value !== "object" ||
			value === null ||
			!value.field ||
			typeof value.field !== "object"
		) {
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

function isGitHubIssueNode(
	node: unknown,
): node is GitHubProjectItemNode & { content: GitHubProjectItemContent } {
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

function isMatchingIssueProjectItem(
	node: unknown,
	options: Pick<
		GitHubProjectStatusUpdateOptions,
		"owner" | "repository" | "issueNumber"
	>,
) {
	if (typeof node !== "object" || node === null) {
		return false;
	}

	const item = node as GitHubProjectStatusItemNode;
	const content = item.content;

	if (!content || content.__typename !== "Issue") {
		return false;
	}

	return (
		safeNumber(content.number) === options.issueNumber &&
		safeString(content.repository?.name) === options.repository &&
		safeString(content.repository?.owner?.login) === options.owner
	);
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

const GITHUB_PROJECT_STATUS_TARGET_QUERY = `
	query FetchProjectIssueStatusTarget(
		$owner: String!,
		$projectNumber: Int!
	) {
		user(login: $owner) {
			projectV2(number: $projectNumber) {
				id
				fields(first: 50) {
					nodes {
						__typename
						... on ProjectV2SingleSelectField {
							id
							name
							options {
								id
								name
							}
						}
					}
				}
				items(first: 100) {
					nodes {
						id
						content {
							__typename
							... on Issue {
								number
								repository {
									name
									owner {
										login
									}
								}
							}
						}
					}
				}
			}
		}
	}
`;

const UPDATE_PROJECT_ITEM_SINGLE_SELECT_MUTATION = `
	mutation UpdateProjectItemSingleSelect(
		$projectId: ID!,
		$itemId: ID!,
		$fieldId: ID!,
		$optionId: String!
	) {
		updateProjectV2ItemFieldValue(
			input: {
				projectId: $projectId,
				itemId: $itemId,
				fieldId: $fieldId,
				value: { singleSelectOptionId: $optionId }
			}
		) {
			projectV2Item {
				id
			}
		}
	}
`;
