import {
	isRhapsodyRunner,
	loadRhapsodyConfig,
	type RhapsodyRunner,
} from "@/lib/config";
import {
	fetchGitHubIssue,
	type GitHubIssue,
	GitHubIssueFetchError,
} from "@/lib/github/issues";
import { requireAdminAuth } from "@/lib/server/admin-auth";
import { isRecord, optionalString, readJson } from "@/lib/server/json";
import { createClaimedManualRun, createStateStoreClient } from "@/lib/state";

export const runtime = "nodejs";

type ManualRunRequest = {
	workItemId: string;
	workItemTitle: string;
	workItemUrl?: string | null;
	workItemStatus?: string | null;
	workItemSnapshot?: unknown;
	claimedBy?: string;
	runner?: RhapsodyRunner;
};

type GitHubIssueRunRequest = {
	issueNumber: number;
	claimedBy?: string;
	runner?: RhapsodyRunner;
};

type RunRequest = ManualRunRequest | GitHubIssueRunRequest;

export async function POST(request: Request) {
	const auth = await requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const body = await readJson(request);

	if (!body.ok) {
		return body.response;
	}

	const parsed = parseManualRunRequest(body.value);

	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	const config = loadRhapsodyConfig();
	const runInputResult = await resolveRunInput(parsed.value, config);

	if (!runInputResult.ok) {
		return runInputResult.response;
	}

	const runInput = runInputResult.value;
	const client = createStateStoreClient();

	try {
		const result = await createClaimedManualRun(client, {
			...runInput,
			runner: runInput.runner ?? config.runner.kind,
			claimedBy: runInput.claimedBy ?? "manual",
			claimTtlMs: config.runner.claimTtlMs,
		});

		if (!result.acquired) {
			return Response.json(
				{ acquired: false, existingRunId: result.existingRunId },
				{ status: 409 },
			);
		}

		return Response.json(result, { status: 201 });
	} finally {
		client.close();
	}
}

function parseManualRunRequest(
	value: unknown,
): { ok: true; value: RunRequest } | { ok: false; error: string } {
	if (!isRecord(value)) {
		return { ok: false, error: "Request body must be a JSON object." };
	}

	if ("issueNumber" in value) {
		return parseGitHubIssueRunRequest(value);
	}

	if (typeof value.workItemId !== "string" || !value.workItemId.trim()) {
		return { ok: false, error: "workItemId must be a non-empty string." };
	}

	if (typeof value.workItemTitle !== "string" || !value.workItemTitle.trim()) {
		return { ok: false, error: "workItemTitle must be a non-empty string." };
	}

	const workItemUrl = optionalString(value.workItemUrl);

	if (workItemUrl === undefined && "workItemUrl" in value) {
		return {
			ok: false,
			error: "workItemUrl must be a string or null when provided.",
		};
	}

	const workItemStatus = optionalString(value.workItemStatus);

	if (workItemStatus === undefined && "workItemStatus" in value) {
		return {
			ok: false,
			error: "workItemStatus must be a string or null when provided.",
		};
	}

	const claimedBy = optionalString(value.claimedBy);

	if (claimedBy === null || (claimedBy === undefined && "claimedBy" in value)) {
		return { ok: false, error: "claimedBy must be a string when provided." };
	}

	if (claimedBy !== undefined && !claimedBy.trim()) {
		return {
			ok: false,
			error: "claimedBy must be a non-empty string when provided.",
		};
	}

	const runner = parseRunner(value.runner);

	if (!runner.ok) {
		return runner;
	}

	return {
		ok: true,
		value: {
			workItemId: value.workItemId,
			workItemTitle: value.workItemTitle,
			workItemUrl,
			workItemStatus,
			workItemSnapshot: value.workItemSnapshot,
			claimedBy,
			runner: runner.value,
		},
	};
}

function parseGitHubIssueRunRequest(
	value: Record<string, unknown>,
): { ok: true; value: GitHubIssueRunRequest } | { ok: false; error: string } {
	const issueNumber = value.issueNumber;

	if (
		typeof issueNumber !== "number" ||
		!Number.isInteger(issueNumber) ||
		issueNumber <= 0
	) {
		return { ok: false, error: "issueNumber must be a positive integer." };
	}

	const claimedBy = optionalString(value.claimedBy);

	if (claimedBy === null || (claimedBy === undefined && "claimedBy" in value)) {
		return { ok: false, error: "claimedBy must be a string when provided." };
	}

	if (claimedBy !== undefined && !claimedBy.trim()) {
		return {
			ok: false,
			error: "claimedBy must be a non-empty string when provided.",
		};
	}

	const runner = parseRunner(value.runner);

	if (!runner.ok) {
		return runner;
	}

	return {
		ok: true,
		value: {
			issueNumber,
			claimedBy,
			runner: runner.value,
		},
	};
}

function parseRunner(
	value: unknown,
): { ok: true; value?: RhapsodyRunner } | { ok: false; error: string } {
	if (value === undefined) {
		return { ok: true };
	}

	if (!isRhapsodyRunner(value)) {
		return {
			ok: false,
			error:
				"runner must be one of: fake, sandbox-fake, codex-local, sandbox-codex.",
		};
	}

	return { ok: true, value };
}

async function resolveRunInput(
	request: RunRequest,
	config: ReturnType<typeof loadRhapsodyConfig>,
): Promise<
	| { ok: true; value: ManualRunRequest & { source?: "github_issue" } }
	| { ok: false; response: Response }
> {
	if (!("issueNumber" in request)) {
		return { ok: true, value: request };
	}

	let issue: GitHubIssue;

	try {
		issue = await fetchGitHubIssue({
			owner: config.repository.owner,
			repository: config.repository.name,
			issueNumber: request.issueNumber,
		});
	} catch (error) {
		if (error instanceof GitHubIssueFetchError) {
			return {
				ok: false,
				response: Response.json(
					{
						error:
							error.status === 404
								? "GitHub issue not found."
								: "GitHub issue fetch failed.",
					},
					{ status: error.status === 404 ? 404 : 502 },
				),
			};
		}

		throw error;
	}

	return {
		ok: true,
		value: {
			source: "github_issue",
			workItemId: `github_issue:${config.repository.owner}/${config.repository.name}#${issue.number}`,
			workItemTitle: issue.title,
			workItemUrl: issue.htmlUrl,
			workItemStatus: issue.state,
			workItemSnapshot: {
				source: "github_issue",
				repository: {
					owner: config.repository.owner,
					name: config.repository.name,
				},
				issue,
			},
			claimedBy: request.claimedBy,
		},
	};
}
