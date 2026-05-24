import { Octokit } from "@octokit/rest";

import { loadRhapsodyGitHubEnv, type RhapsodyGitHubEnv } from "@/lib/config";

export type PullRequestCheckClassification =
	| "checks_pending"
	| "checks_success"
	| "ci_failed"
	| "checks_unknown";

export type PullRequestCheckRunActionsSummary = {
	workflowRunId: number | null;
	workflowName: string | null;
	workflowPath: string | null;
	jobId: number | null;
	jobName: string | null;
	failedStepNames: string[];
};

export type PullRequestCheckRunSummary = {
	name: string;
	status: string;
	conclusion: string | null;
	detailsUrl: string | null;
	actions?: PullRequestCheckRunActionsSummary | null;
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
type GetWorkflowRunFn = Octokit["rest"]["actions"]["getWorkflowRun"];
type ListJobsForWorkflowRunFn =
	Octokit["rest"]["actions"]["listJobsForWorkflowRun"];
type PullRequestResponse = Awaited<ReturnType<PullRequestResponseFn>>;
type ListCheckRunsResponse = Awaited<ReturnType<ListCheckRunsFn>>;
type GetCombinedStatusResponse = Awaited<ReturnType<GetCombinedStatusFn>>;
type GetWorkflowRunResponse = Awaited<ReturnType<GetWorkflowRunFn>>;
type ListJobsForWorkflowRunResponse = Awaited<
	ReturnType<ListJobsForWorkflowRunFn>
>;
type CheckRuns = ListCheckRunsResponse["data"]["check_runs"];
type ActionsJobs = ListJobsForWorkflowRunResponse["data"]["jobs"];
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
		actions: {
			getWorkflowRun: (
				...args: Parameters<GetWorkflowRunFn>
			) => ReturnType<GetWorkflowRunFn>;
			listJobsForWorkflowRun: (
				...args: Parameters<ListJobsForWorkflowRunFn>
			) => ReturnType<ListJobsForWorkflowRunFn>;
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

	const actionsMetadata = await fetchActionsMetadataForCheckRuns(
		input,
		response.data.check_runs ?? [],
		env,
		options,
	);
	const runs = normalizeCheckRuns(
		response.data.check_runs ?? [],
		actionsMetadata,
	);
	return {
		ok: true,
		status: runs.length > 0 ? "available" : "none",
		checkRuns: runs,
	};
}

type WorkflowRunJobMetadata = {
	jobId: number;
	jobName: string;
	failedStepNames: string[];
};

type WorkflowRunMetadata = {
	workflowRunId: number;
	workflowName: string | null;
	workflowPath: string | null;
	jobsById: Map<number, WorkflowRunJobMetadata>;
	jobsByName: Map<string, WorkflowRunJobMetadata[]>;
};

async function fetchActionsMetadataForCheckRuns(
	input: {
		owner: string;
		repository: string;
	},
	checkRuns: CheckRuns,
	env: RhapsodyGitHubEnv,
	options?: {
		octokit?: OctokitChecksClient;
	},
): Promise<Map<number, PullRequestCheckRunActionsSummary>> {
	const parsedCheckRuns = checkRuns
		.map((checkRun) => {
			const checkRunId = typeof checkRun.id === "number" ? checkRun.id : null;
			const detailsUrl =
				typeof checkRun.details_url === "string" ? checkRun.details_url : null;
			const parsedDetailsUrl = parseActionsDetailsUrl(detailsUrl);
			const checkRunName =
				typeof checkRun.name === "string" ? checkRun.name.trim() : "";

			return {
				checkRunId,
				checkRunName,
				parsedDetailsUrl,
			};
		})
		.filter(
			(
				checkRun,
			): checkRun is {
				checkRunId: number;
				checkRunName: string;
				parsedDetailsUrl: {
					workflowRunId: number;
					jobId: number | null;
				};
			} => checkRun.checkRunId !== null && checkRun.parsedDetailsUrl !== null,
		);

	if (parsedCheckRuns.length === 0) {
		return new Map();
	}

	const workflowRunIds = Array.from(
		new Set(
			parsedCheckRuns.map(
				(checkRun) => checkRun.parsedDetailsUrl.workflowRunId,
			),
		),
	);
	const metadataEntries = await Promise.all(
		workflowRunIds.map(async (workflowRunId) => {
			try {
				const metadata = await loadWorkflowRunMetadata(
					input,
					workflowRunId,
					env,
					options,
				);
				return [workflowRunId, metadata] as const;
			} catch {
				return null;
			}
		}),
	);
	const metadataByWorkflowRunId = new Map<number, WorkflowRunMetadata>();

	for (const entry of metadataEntries) {
		if (!entry) {
			continue;
		}

		metadataByWorkflowRunId.set(entry[0], entry[1]);
	}

	const actionsMetadataByCheckRunId = new Map<
		number,
		PullRequestCheckRunActionsSummary
	>();

	for (const checkRun of parsedCheckRuns) {
		const workflowRunMetadata = metadataByWorkflowRunId.get(
			checkRun.parsedDetailsUrl.workflowRunId,
		);
		if (!workflowRunMetadata) {
			continue;
		}

		const jobMetadata =
			(checkRun.parsedDetailsUrl.jobId !== null
				? workflowRunMetadata.jobsById.get(checkRun.parsedDetailsUrl.jobId)
				: undefined) ??
			findWorkflowJobByName(
				workflowRunMetadata.jobsByName,
				checkRun.checkRunName,
			);

		actionsMetadataByCheckRunId.set(checkRun.checkRunId, {
			workflowRunId: workflowRunMetadata.workflowRunId,
			workflowName: workflowRunMetadata.workflowName,
			workflowPath: workflowRunMetadata.workflowPath,
			jobId: jobMetadata?.jobId ?? checkRun.parsedDetailsUrl.jobId,
			jobName:
				jobMetadata?.jobName ??
				(checkRun.checkRunName.length > 0 ? checkRun.checkRunName : null),
			failedStepNames: jobMetadata?.failedStepNames ?? [],
		});
	}

	return actionsMetadataByCheckRunId;
}

async function loadWorkflowRunMetadata(
	input: {
		owner: string;
		repository: string;
	},
	workflowRunId: number,
	env: RhapsodyGitHubEnv,
	options?: {
		octokit?: OctokitChecksClient;
	},
): Promise<WorkflowRunMetadata> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });
	const workflowRunResponse = await octokit.rest.actions.getWorkflowRun({
		owner: input.owner,
		repo: input.repository,
		run_id: workflowRunId,
		headers: {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		},
	});
	const jobs = await listWorkflowRunJobs(input, workflowRunId, env, options);
	const jobsById = new Map<number, WorkflowRunJobMetadata>();
	const jobsByName = new Map<string, WorkflowRunJobMetadata[]>();

	for (const job of jobs) {
		const metadata = {
			jobId: job.jobId,
			jobName: job.jobName,
			failedStepNames: job.failedStepNames,
		} satisfies WorkflowRunJobMetadata;
		jobsById.set(metadata.jobId, metadata);

		const existing = jobsByName.get(metadata.jobName) ?? [];
		existing.push(metadata);
		jobsByName.set(metadata.jobName, existing);
	}

	return {
		workflowRunId,
		workflowName: normalizeOptionalString(workflowRunResponse.data.name),
		workflowPath: normalizeWorkflowPath(
			readWorkflowRunPath(workflowRunResponse),
		),
		jobsById,
		jobsByName,
	};
}

async function listWorkflowRunJobs(
	input: {
		owner: string;
		repository: string;
	},
	workflowRunId: number,
	env: RhapsodyGitHubEnv,
	options?: {
		octokit?: OctokitChecksClient;
	},
): Promise<WorkflowRunJobMetadata[]> {
	const octokit = options?.octokit ?? new Octokit({ auth: env.GITHUB_TOKEN });
	const jobs: WorkflowRunJobMetadata[] = [];
	const perPage = 100;
	let page = 1;

	while (true) {
		const response = await octokit.rest.actions.listJobsForWorkflowRun({
			owner: input.owner,
			repo: input.repository,
			run_id: workflowRunId,
			per_page: perPage,
			page,
			headers: {
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		const payload = response.data.jobs ?? [];

		for (const job of payload) {
			const jobId = typeof job.id === "number" ? job.id : null;
			const jobName = normalizeOptionalString(job.name);

			if (jobId === null || !jobName) {
				continue;
			}

			jobs.push({
				jobId,
				jobName,
				failedStepNames: extractFailedStepNames(job.steps),
			});
		}

		const linkHeader = response.headers.link;
		if (
			payload.length < perPage ||
			!linkHeader ||
			!linkHeader.includes('rel="next"')
		) {
			return jobs;
		}

		page += 1;
	}
}

function normalizeCheckRuns(
	payload: CheckRuns,
	actionsMetadataByCheckRunId = new Map<
		number,
		PullRequestCheckRunActionsSummary
	>(),
): PullRequestCheckRunSummary[] {
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
			const checkRunId = typeof checkRun.id === "number" ? checkRun.id : null;
			const actions =
				checkRunId !== null
					? (actionsMetadataByCheckRunId.get(checkRunId) ?? null)
					: null;

			return {
				name: name.trim() || "unknown",
				status,
				conclusion,
				detailsUrl,
				...(actions ? { actions } : {}),
			};
		})
		.slice(0, 20);
}

function parseActionsDetailsUrl(detailsUrl: string | null) {
	if (!detailsUrl) {
		return null;
	}

	const match = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(detailsUrl);
	if (!match) {
		return null;
	}

	const workflowRunId = Number.parseInt(match[1] ?? "", 10);
	const jobId = match[2] ? Number.parseInt(match[2], 10) : null;

	if (!Number.isFinite(workflowRunId) || workflowRunId <= 0) {
		return null;
	}

	if (jobId !== null && (!Number.isFinite(jobId) || jobId <= 0)) {
		return null;
	}

	return {
		workflowRunId,
		jobId,
	};
}

function findWorkflowJobByName(
	jobsByName: Map<string, WorkflowRunJobMetadata[]>,
	jobName: string,
) {
	const matches = jobsByName.get(jobName) ?? [];
	return matches.length === 1 ? matches[0] : null;
}

function readWorkflowRunPath(response: GetWorkflowRunResponse) {
	const payload = response.data as GetWorkflowRunResponse["data"] & {
		path?: unknown;
	};
	return typeof payload.path === "string" ? payload.path : null;
}

function normalizeWorkflowPath(value: string | null) {
	if (!value) {
		return null;
	}

	const normalized = value.split("@", 1)[0]?.trim() ?? "";
	return normalized.length > 0 ? normalized : null;
}

function normalizeOptionalString(value: unknown) {
	return typeof value === "string" && value.trim().length > 0
		? value.trim()
		: null;
}

function extractFailedStepNames(steps: ActionsJobs[number]["steps"]) {
	if (!Array.isArray(steps)) {
		return [];
	}

	return steps
		.filter((step) => {
			const conclusion =
				typeof step.conclusion === "string" ? step.conclusion : null;
			return (
				conclusion !== null &&
				[
					"failure",
					"error",
					"timed_out",
					"cancelled",
					"action_required",
				].includes(conclusion)
			);
		})
		.map((step) => (typeof step.name === "string" ? step.name.trim() : ""))
		.filter((stepName) => stepName.length > 0);
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
