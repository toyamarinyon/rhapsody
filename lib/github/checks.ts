import { loadRhapsodyGitHubEnv, type RhapsodyGitHubEnv } from "@/lib/config";

export type PullRequestCheckClassification =
	| "checks_pending"
	| "checks_success"
	| "ci_failed"
	| "checks_unknown";

export type PullRequestCheckRunSummary = {
	name: string;
	status: string;
	conclusion: string | null;
	detailsUrl: string | null;
};

export type PullRequestCheckSummary = {
	classification: PullRequestCheckClassification;
	headSha: string | null;
	status: string | null;
	checkRuns: PullRequestCheckRunSummary[];
	reason?: string;
	rawState?: string | null;
	fallbackStatus?: string | null;
};

type GitHubPullRequestResponse = {
	number: number;
	html_url: string;
	head: {
		sha: string;
	};
};

type GitHubCommitStatusResponse = {
	state: string;
};

type GitHubCommitCheckRunResponse = {
	check_runs?: Array<{
		name?: unknown;
		status?: unknown;
		conclusion?: unknown;
		details_url?: unknown;
	}> | null;
};

export async function getPullRequestCheckSummary(
	input: {
		owner: string;
		repository: string;
		pullRequestNumber: number;
	},
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
): Promise<PullRequestCheckSummary> {
	try {
		const pullRequest = await fetchPullRequest(input, env);

		const checkRunResult = await fetchCheckRuns(
			{
				owner: input.owner,
				repository: input.repository,
			},
			pullRequest.head.sha,
			env,
		);
		if (checkRunResult.ok) {
			const classification = classifyCheckRuns(checkRunResult.checkRuns);
			if (classification !== "checks_unknown") {
				return {
					classification,
					headSha: pullRequest.head.sha,
					status: checkRunResult.status,
					checkRuns: checkRunResult.checkRuns,
					rawState: checkRunResult.status,
				};
			}
		}

		const status = await fetchCommitCheckStatus(
			{
				owner: input.owner,
				repository: input.repository,
			},
			pullRequest.head.sha,
			env,
		);
		if (!status.ok) {
			return {
				classification: "checks_unknown",
				headSha: pullRequest.head.sha,
				status: status.state,
				checkRuns: [],
				rawState: status.state,
				reason: status.reason,
				fallbackStatus: "commit_status_unknown",
			};
		}

		const classification = classifyCommitStatusState(status.state);
		return {
			classification,
			headSha: pullRequest.head.sha,
			status: status.state,
			checkRuns: [],
			rawState: status.state,
			fallbackStatus: "commit_status",
		};
	} catch (error) {
		return {
			classification: "checks_unknown",
			status: null,
			headSha: null,
			checkRuns: [],
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}

function classifyCommitStatusState(
	state: string,
): PullRequestCheckClassification {
	switch (state) {
		case "pending":
			return "checks_pending";
		case "success":
			return "checks_success";
		case "failure":
		case "error":
		case "timed_out":
		case "cancelled":
			return "ci_failed";
		default:
			return "checks_unknown";
	}
}

function classifyCheckRuns(
	checkRuns: PullRequestCheckRunSummary[],
): PullRequestCheckClassification {
	if (!Array.isArray(checkRuns) || checkRuns.length === 0) {
		return "checks_unknown";
	}

	const pendingStatuses = new Set([
		"queued",
		"in_progress",
		"requested",
		"waiting",
		"pending",
	]);
	const failedConclusions = new Set([
		"failure",
		"error",
		"timed_out",
		"cancelled",
		"action_required",
	]);
	const successConclusions = new Set(["success", "skipped", "neutral"]);

	let hasUsableCheck = false;
	let hasFailure = false;
	let hasNonSuccessCompletion = false;

	for (const checkRun of checkRuns) {
		if (!checkRun.status) {
			continue;
		}

		hasUsableCheck = true;
		const status = checkRun.status.toLowerCase();
		const conclusion = (checkRun.conclusion ?? "").toLowerCase();

		if (pendingStatuses.has(status)) {
			return "checks_pending";
		}

		if (status === "completed") {
			if (failedConclusions.has(conclusion)) {
				hasFailure = true;
			}

			if (!successConclusions.has(conclusion)) {
				hasNonSuccessCompletion = true;
			}
		}
	}

	if (!hasUsableCheck) {
		return "checks_unknown";
	}

	if (hasFailure || hasNonSuccessCompletion) {
		return "ci_failed";
	}

	return "checks_success";
}

async function fetchPullRequest(
	input: {
		owner: string;
		repository: string;
		pullRequestNumber: number;
	},
	env: RhapsodyGitHubEnv,
): Promise<GitHubPullRequestResponse> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls/${input.pullRequestNumber}`,
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
		throw new Error(`GitHub pull request lookup failed: ${message}`);
	}

	const payload = (await response.json()) as unknown;
	if (!isGitHubPullRequestResponse(payload)) {
		throw new Error("GitHub pull request response had an unexpected shape.");
	}

	return payload;
}

async function fetchCheckRuns(
	input: {
		owner: string;
		repository: string;
	},
	headSha: string,
	env: RhapsodyGitHubEnv,
): Promise<
	| { ok: true; status: string; checkRuns: PullRequestCheckRunSummary[] }
	| { ok: false; status: string; reason: string }
> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/commits/${encodeURIComponent(headSha)}/check-runs`,
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
		return {
			ok: false,
			status: "unknown",
			reason: `GitHub check-runs lookup failed: ${message}`,
		};
	}

	const payload = (await response.json()) as GitHubCommitCheckRunResponse;
	const runs = normalizeCheckRuns(payload);

	return {
		ok: true,
		status: runs.length > 0 ? "available" : "none",
		checkRuns: runs,
	};
}

function normalizeCheckRuns(
	payload: GitHubCommitCheckRunResponse,
): PullRequestCheckRunSummary[] {
	if (!Array.isArray(payload.check_runs)) {
		return [];
	}

	return payload.check_runs
		.filter(
			(
				checkRun,
			): checkRun is {
				name?: unknown;
				status?: unknown;
				conclusion?: unknown;
				details_url?: unknown;
			} =>
				typeof checkRun === "object" &&
				checkRun !== null &&
				"status" in checkRun,
		)
		.map((checkRun) => {
			const name =
				typeof checkRun.name === "string" && checkRun.name.trim().length > 0
					? checkRun.name
					: "unknown";
			const status =
				typeof checkRun.status === "string" ? checkRun.status : "unknown";
			const conclusion =
				typeof checkRun.conclusion === "string" ? checkRun.conclusion : null;
			const detailsUrl =
				typeof checkRun.details_url === "string" ? checkRun.details_url : null;

			return {
				name,
				status,
				conclusion,
				detailsUrl,
			};
		})
		.slice(0, 20);
}

async function fetchCommitCheckStatus(
	input: {
		owner: string;
		repository: string;
	},
	headSha: string,
	env: RhapsodyGitHubEnv,
): Promise<
	{ ok: true; state: string } | { ok: false; state: string; reason: string }
> {
	const response = await fetch(
		`https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/commits/${encodeURIComponent(headSha)}/status`,
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
		return {
			ok: false,
			state: "unknown",
			reason: `GitHub commit status lookup failed: ${message}`,
		};
	}

	const payload = (await response.json()) as unknown;
	if (!isGitHubCommitStatusResponse(payload)) {
		return {
			ok: false,
			state: "unknown",
			reason: "GitHub commit status response had an unexpected shape.",
		};
	}

	return { ok: true, state: payload.state };
}

function isGitHubPullRequestResponse(
	value: unknown,
): value is GitHubPullRequestResponse {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const pullRequest = value as Partial<GitHubPullRequestResponse>;
	return (
		typeof pullRequest.number === "number" &&
		typeof pullRequest.head === "object" &&
		pullRequest.head !== null &&
		typeof pullRequest.head.sha === "string"
	);
}

function isGitHubCommitStatusResponse(
	value: unknown,
): value is GitHubCommitStatusResponse {
	if (typeof value !== "object" || value === null) {
		return false;
	}

	const status = value as Partial<GitHubCommitStatusResponse>;
	return typeof status.state === "string";
}

async function safeResponseText(response: Response): Promise<string> {
	try {
		const text = await response.text();
		return text || `${response.status} ${response.statusText}`;
	} catch {
		return `${response.status} ${response.statusText}`;
	}
}
