import { Octokit } from "@octokit/rest";

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

type PullRequestResponseFn = Octokit["rest"]["pulls"]["get"];
type ListCheckRunsFn = Octokit["rest"]["checks"]["listForRef"];
type GetCombinedStatusFn = Octokit["rest"]["repos"]["getCombinedStatusForRef"];
type PullRequestResponse = Awaited<ReturnType<PullRequestResponseFn>>;
type ListCheckRunsResponse = Awaited<ReturnType<ListCheckRunsFn>>;
type GetCombinedStatusResponse = Awaited<ReturnType<GetCombinedStatusFn>>;
type CheckRuns = ListCheckRunsResponse["data"]["check_runs"];
type OctokitChecksClient = {
	rest: {
		pulls: {
			get: (
				...args: Parameters<PullRequestResponseFn>
			) => ReturnType<PullRequestResponseFn>;
		};
		checks: {
			listForRef: (
				...args: Parameters<ListCheckRunsFn>
			) => ReturnType<ListCheckRunsFn>;
		};
		repos: {
			getCombinedStatusForRef: (
				...args: Parameters<GetCombinedStatusFn>
			) => ReturnType<GetCombinedStatusFn>;
		};
	};
};

export async function getPullRequestCheckSummary(
	input: {
		owner: string;
		repository: string;
		pullRequestNumber: number;
	},
	env: RhapsodyGitHubEnv = loadRhapsodyGitHubEnv(),
	options?: {
		octokit?: OctokitChecksClient;
	},
): Promise<PullRequestCheckSummary> {
	try {
		const pullRequest = await fetchPullRequest(input, env, options);

		const checkRunResult = await fetchCheckRuns(
			{
				owner: input.owner,
				repository: input.repository,
			},
			pullRequest.head.sha,
			env,
			options,
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
			options,
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
	options?: {
		octokit?: OctokitChecksClient;
	},
): Promise<{ number: number; head: { sha: string } }> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });

	let response: PullRequestResponse;
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
		const reason = error instanceof Error ? error.message : "request failed";
		throw new Error(`GitHub pull request lookup failed: ${reason}`);
	}

	const payload = response.data;
	return {
		number: payload.number,
		head: {
			sha: payload.head.sha,
		},
	};
}

async function fetchCheckRuns(
	input: {
		owner: string;
		repository: string;
	},
	headSha: string,
	env: RhapsodyGitHubEnv,
	options?: {
		octokit?: OctokitChecksClient;
	},
): Promise<
	| { ok: true; status: string; checkRuns: PullRequestCheckRunSummary[] }
	| { ok: false; status: string; reason: string }
> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });
	let response: ListCheckRunsResponse;
	try {
		response = await octokit.rest.checks.listForRef({
			owner: input.owner,
			repo: input.repository,
			ref: headSha,
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : "request failed";
		return {
			ok: false,
			status: "unknown",
			reason: `GitHub check-runs lookup failed: ${reason}`,
		};
	}

	const runs = normalizeCheckRuns(response.data.check_runs ?? []);
	return {
		ok: true,
		status: runs.length > 0 ? "available" : "none",
		checkRuns: runs,
	};
}

function normalizeCheckRuns(payload: CheckRuns): PullRequestCheckRunSummary[] {
	return payload
		.map((checkRun) => {
			const name =
				typeof checkRun.name === "string" ? checkRun.name : "unknown";
			const status =
				typeof checkRun.status === "string" ? checkRun.status : "unknown";
			const conclusion =
				typeof checkRun.conclusion === "string" ? checkRun.conclusion : null;
			const detailsUrl =
				typeof checkRun.details_url === "string" ? checkRun.details_url : null;

			return {
				name: name.trim() || "unknown",
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
	options?: {
		octokit?: OctokitChecksClient;
	},
): Promise<
	{ ok: true; state: string } | { ok: false; state: string; reason: string }
> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });
	let response: GetCombinedStatusResponse;
	try {
		response = await octokit.rest.repos.getCombinedStatusForRef({
			owner: input.owner,
			repo: input.repository,
			ref: headSha,
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
	} catch (error) {
		const reason = error instanceof Error ? error.message : "request failed";
		return {
			ok: false,
			state: "unknown",
			reason: `GitHub commit status lookup failed: ${reason}`,
		};
	}

	return { ok: true, state: response.data.state };
}
