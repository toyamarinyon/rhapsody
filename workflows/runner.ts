import { runAttemptExecution } from "@/lib/runners/registry";
import { loadRhapsodyConfig } from "@/lib/config";
import {
	createOrReuseOpenPullRequest,
	mergePullRequest,
	type PullRequestMergeResult,
} from "@/lib/github/pull-requests";
import { updateProjectIssueStatus } from "@/lib/github/project-items";
import { parseWorkItemIssueNumber } from "@/lib/attempt-branch";
import {
	applyAttemptTerminalCallback,
	createEvent,
	getRunDetail,
	createStateStoreClient,
	type AttemptTransitionResult,
} from "@/lib/state";
import { buildAttemptHookToken } from "@/lib/workflows/attempt-hook";
import {
	evaluatePostRunDecision,
	loadPostRunDecisionConfig,
	getPostRunStatusConfig,
	type PostRunDecisionStatusConfig,
	type PostRunDecision,
} from "@/lib/post-run-decision";
import { createHook } from "workflow";

export type RunnerWorkflowInput = {
	runId: string;
	attemptId: string;
	startedBy?: string;
	callbackBaseUrl?: string;
};

export type RunnerWorkflowOutput = {
	runId: string;
	attemptId: string;
	startedBy?: string;
	responseStatus: number;
	responseBody: string;
	hookToken: string;
	callbackPayload: RunnerWorkflowCallbackPayload;
	handoff: RunnerWorkflowHandoffResult;
	postRunDecision: PostRunDecision;
	postRunAction: RunnerWorkflowPostRunActionResult;
	finalization: AttemptTransitionResult;
};

export type RunnerWorkflowCallbackPayload = {
	runId: string;
	attemptId: string;
	claimToken: string;
	executionStatus: string;
	exitCode?: number | null;
	sandboxId?: string | null;
	commandId?: string | null;
	startedAt?: number | null;
	completedAt?: number | null;
	error?: string | null;
	branchName?: string | null;
	prSpec?: unknown;
	postflight?: unknown;
};

export type RunnerWorkflowHandoff = {
	reused: boolean;
	number: number;
	htmlUrl: string;
	headRef: string;
	baseRef: string;
	title: string;
};

export type RunnerWorkflowHandoffResult =
	| {
			ok: true;
			pullRequest: RunnerWorkflowHandoff | null;
	  }
	| {
			ok: false;
			pullRequest: null;
			error: string;
	  };

export type RunnerWorkflowPostRunActionResult = {
	action: PostRunDecision["action"];
	pullRequestMerge:
		| { attempted: false }
		| { attempted: true; merged: true; result: PullRequestMergeResult }
		| { attempted: true; merged: false; error: string };
	projectStatusUpdate:
		| { attempted: false }
		| {
				attempted: true;
				updated: true;
				targetStatus: string;
				itemId: string;
				fieldId: string;
				optionId: string;
		  }
		| { attempted: true; updated: false; targetStatus: string; error: string };
};

type PostRunPolicyEvaluation = {
	decision: PostRunDecision;
	statusConfig: PostRunDecisionStatusConfig;
};

export async function runnerWorkflow(input: RunnerWorkflowInput) {
	"use workflow";

	const hookToken = buildAttemptHookToken(input.attemptId);
	const hook = createHook<RunnerWorkflowCallbackPayload>({
		token: hookToken,
	});
	const launched = await runRunnerAttempt(input, hookToken);
	const callbackPayload = await hook;
	const handoff = await completeRunnerHandoff(input, callbackPayload);
	const finalization = await finalizeRunnerAttempt(callbackPayload, handoff);
	const postRunPolicy = await evaluatePostRunPolicy(
		input,
		callbackPayload,
		handoff,
		finalization,
	);
	const postRunDecision = postRunPolicy.decision;
	const postRunAction = await applyPostRunDecisionAction(
		input,
		handoff,
		postRunDecision,
		postRunPolicy.statusConfig,
	);

	return {
		runId: input.runId,
		attemptId: input.attemptId,
		startedBy: input.startedBy,
		responseStatus: launched.responseStatus,
		responseBody: launched.responseBody,
		hookToken: launched.hookToken,
		callbackPayload,
		handoff,
		postRunDecision,
		postRunAction,
		finalization,
	} satisfies RunnerWorkflowOutput;
}

async function runRunnerAttempt(input: RunnerWorkflowInput, hookToken: string) {
	"use step";

	const callbackBaseUrl =
		input.callbackBaseUrl ??
		`https://${(process.env.VERCEL_URL ?? "localhost").replace(/^https?:\/\//, "")}`;
	const request = new Request(new URL("/", callbackBaseUrl), {
		method: "POST",
		body: JSON.stringify({
			callbackBaseUrl,
			hookToken,
		}),
	});
	const response = await runAttemptExecution({
		request,
		runId: input.runId,
		attemptId: input.attemptId,
		runner: null,
	});
	const responseBody = await response.text();

	if (!response.ok) {
		throw new Error(
			`Runner launch failed with HTTP ${response.status}: ${responseBody}`,
		);
	}

	return {
		responseStatus: response.status,
		responseBody,
		hookToken,
	};
}

async function completeRunnerHandoff(
	input: RunnerWorkflowInput,
	callbackPayload: RunnerWorkflowCallbackPayload,
): Promise<RunnerWorkflowHandoffResult> {
	"use step";

	if (
		callbackPayload.executionStatus !== "completed" ||
		!callbackPayload.branchName ||
		!isPrSpec(callbackPayload.prSpec)
	) {
		return { ok: true, pullRequest: null };
	}

	const config = loadRhapsodyConfig();
	const client = createStateStoreClient();

	try {
		const detail = await getRunDetail(client, input.runId);
		const issueNumber = detail
			? parseWorkItemIssueNumber({ workItemId: detail.run.workItemId })
			: null;
		const handoff = await createOrReuseOpenPullRequest({
			owner: config.repository.owner,
			repository: config.repository.name,
			base: config.repository.defaultBranch,
			head: callbackPayload.branchName,
			title: callbackPayload.prSpec.title,
			body: appendIssueReference(callbackPayload.prSpec.body, issueNumber),
		});

		await createEvent(client, {
			runId: input.runId,
			attemptId: input.attemptId,
			level: "info",
			type: "sandbox_codex_runner.pull_request_ready",
			message: "Runner workflow created or reused a pull request for handoff.",
			data: {
				prSpec: callbackPayload.prSpec,
				pullRequest: handoff,
			},
		});

		return { ok: true, pullRequest: handoff satisfies RunnerWorkflowHandoff };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		await createEvent(client, {
			runId: input.runId,
			attemptId: input.attemptId,
			level: "error",
			type: "sandbox_codex_runner.pull_request_failed",
			message:
				"Runner workflow could not create or reuse a pull request for handoff.",
			data: {
				error: message,
				branchName: callbackPayload.branchName,
				prSpec: callbackPayload.prSpec,
			},
		});

		return { ok: false, pullRequest: null, error: message };
	} finally {
		client.close();
	}
}

async function evaluatePostRunPolicy(
	input: RunnerWorkflowInput,
	callbackPayload: RunnerWorkflowCallbackPayload,
	handoff: RunnerWorkflowHandoffResult,
	finalization: AttemptTransitionResult,
): Promise<PostRunPolicyEvaluation> {
	"use step";

	const client = createStateStoreClient();
	let policyLoadResult;

	try {
		policyLoadResult = await loadPostRunDecisionConfig(process.cwd());
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Unknown error while loading post-run decision policy.";
		policyLoadResult = {
			config: {
				post_run: {
					auto_merge_eligible: [],
					auto_merge_success_status: "Done",
					human_review_status: "Human Review",
				},
			},
			loadedFromPath: ".rhapsody/config.toml",
			errors: [message],
		};
	}

	const changedFiles = extractChangedFiles(callbackPayload);
	const handoffStatus = handoff.ok && handoff.pullRequest ? "ok" : "missing_pr";
	const runStatus = extractTransitionStatus(finalization, "runStatus");
	const attemptStatus = extractTransitionStatus(finalization, "attemptStatus");

	const decision = evaluatePostRunDecision({
		runStatus,
		attemptStatus,
		handoffStatus,
		changedFiles,
		config: policyLoadResult.config,
	});

	try {
		if (policyLoadResult.errors.length > 0) {
			await createEvent(client, {
				runId: input.runId,
				attemptId: input.attemptId,
				level: "warn",
				type: "sandbox_codex_runner.post_run_policy_load_fallback",
				message:
					"Post-run policy file was unavailable; using conservative review-required policy.",
				data: {
					errors: policyLoadResult.errors,
					loadedFromPath: policyLoadResult.loadedFromPath,
					configuredRules:
						policyLoadResult.config.post_run.auto_merge_eligible.length,
				},
			});
		}

		await createEvent(client, {
			runId: input.runId,
			attemptId: input.attemptId,
			level: "info",
			type: "sandbox_codex_runner.post_run_decision",
			message: "Runner workflow evaluated post-run decision policy.",
			data: {
				decision,
				handoffStatus,
				runStatus,
				attemptStatus,
				changedFileCount: changedFiles?.length ?? null,
				postflightSummary: callbackPayload.postflight,
				loadedFromPath: policyLoadResult.loadedFromPath,
			},
		});

		return {
			decision,
			statusConfig: getPostRunStatusConfig(policyLoadResult.config),
		};
	} finally {
		client.close();
	}
}

function extractTransitionStatus(
	transition: AttemptTransitionResult,
	key: "runStatus" | "attemptStatus",
) {
	if (
		typeof transition === "object" &&
		transition !== null &&
		key in transition
	) {
		const value = transition[key];

		if (typeof value === "string") {
			return value;
		}
	}

	return "failed";
}

async function finalizeRunnerAttempt(
	callbackPayload: RunnerWorkflowCallbackPayload,
	handoff: RunnerWorkflowHandoffResult,
) {
	"use step";

	const client = createStateStoreClient();

	try {
		return await applyAttemptTerminalCallback(client, {
			runId: callbackPayload.runId,
			attemptId: callbackPayload.attemptId,
			claimToken: callbackPayload.claimToken,
			executionStatus: evaluateFinalExecutionStatus(callbackPayload, handoff),
			exitCode: callbackPayload.exitCode,
			startedAt: callbackPayload.startedAt,
			completedAt: callbackPayload.completedAt,
			sandboxId: callbackPayload.sandboxId,
			command: callbackPayload.commandId,
			error: evaluateFinalError(callbackPayload, handoff),
		});
	} finally {
		client.close();
	}
}

async function applyPostRunDecisionAction(
	input: RunnerWorkflowInput,
	handoff: RunnerWorkflowHandoffResult,
	decision: PostRunDecision,
	statusConfig: PostRunDecisionStatusConfig,
): Promise<RunnerWorkflowPostRunActionResult> {
	"use step";

	const client = createStateStoreClient();
	const config = loadRhapsodyConfig();
	const detail = await getRunDetail(client, input.runId);
	const issueNumber = detail
		? parseWorkItemIssueNumber({ workItemId: detail.run.workItemId })
		: null;

	try {
		if (!handoff.ok || !handoff.pullRequest) {
			await createEvent(client, {
				runId: input.runId,
				attemptId: input.attemptId,
				level: "warn",
				type: "sandbox_codex_runner.post_run_action_skipped",
				message:
					"Runner workflow skipped post-run side effects because no trusted pull request handoff was available.",
				data: {
					action: decision.action,
					reason: decision.reason,
				},
			});

			return {
				action: decision.action,
				pullRequestMerge: { attempted: false },
				projectStatusUpdate: { attempted: false },
			};
		}

		if (issueNumber === null) {
			await createEvent(client, {
				runId: input.runId,
				attemptId: input.attemptId,
				level: "warn",
				type: "sandbox_codex_runner.post_run_action_skipped",
				message:
					"Runner workflow could not resolve the work item issue number for post-run side effects.",
				data: {
					action: decision.action,
					reason: decision.reason,
					pullRequestNumber: handoff.pullRequest.number,
				},
			});

			return {
				action: decision.action,
				pullRequestMerge: { attempted: false },
				projectStatusUpdate: { attempted: false },
			};
		}

		if (decision.action === "auto_merge_candidate") {
			return await mergePullRequestAndMarkDone({
				client,
				config,
				input,
				handoff: handoff.pullRequest,
				issueNumber,
				status: statusConfig.autoMergeSuccessStatus,
			});
		}

		return await moveProjectItemToHumanReview({
			client,
			config,
			input,
			handoff: handoff.pullRequest,
			issueNumber,
			decision,
			status: statusConfig.humanReviewStatus,
		});
	} finally {
		client.close();
	}
}

async function mergePullRequestAndMarkDone(input: {
	client: ReturnType<typeof createStateStoreClient>;
	config: ReturnType<typeof loadRhapsodyConfig>;
	input: RunnerWorkflowInput;
	handoff: RunnerWorkflowHandoff;
	issueNumber: number;
	status: string;
}): Promise<RunnerWorkflowPostRunActionResult> {
	try {
		const mergeResult = await mergePullRequest({
			owner: input.config.repository.owner,
			repository: input.config.repository.name,
			pullRequestNumber: input.handoff.number,
			commitTitle: input.handoff.title,
		});

		await createEvent(input.client, {
			runId: input.input.runId,
			attemptId: input.input.attemptId,
			level: "info",
			type: "sandbox_codex_runner.pull_request_merged",
			message: "Runner workflow merged the trusted pull request.",
			data: {
				pullRequest: input.handoff,
				mergeResult,
			},
		});

		try {
			const statusResult = await updateProjectIssueStatus({
				owner: input.config.tracker.owner,
				repository: input.config.tracker.repository,
				projectNumber: input.config.tracker.projectNumber,
				statusField: input.config.tracker.statusField,
				issueNumber: input.issueNumber,
				status: input.status,
			});

			await createEvent(input.client, {
				runId: input.input.runId,
				attemptId: input.input.attemptId,
				level: "info",
				type: "sandbox_codex_runner.project_status_updated",
				message: `Runner workflow moved the Project item to ${input.status}.`,
				data: {
					issueNumber: input.issueNumber,
					toStatus: input.status,
					projectItemId: statusResult.itemId,
					fieldId: statusResult.fieldId,
					optionId: statusResult.optionId,
					pullRequestNumber: input.handoff.number,
				},
			});

			return {
				action: "auto_merge_candidate",
				pullRequestMerge: { attempted: true, merged: true, result: mergeResult },
				projectStatusUpdate: {
					attempted: true,
					updated: true,
					targetStatus: input.status,
					itemId: statusResult.itemId,
					fieldId: statusResult.fieldId,
					optionId: statusResult.optionId,
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);

			await createEvent(input.client, {
				runId: input.input.runId,
				attemptId: input.input.attemptId,
				level: "warn",
				type: "sandbox_codex_runner.project_status_update_failed",
				message: `Runner workflow merged the pull request, but could not move the Project item to ${input.status}.`,
				data: {
					issueNumber: input.issueNumber,
					toStatus: input.status,
					error: message,
					pullRequestNumber: input.handoff.number,
				},
			});

			return {
				action: "auto_merge_candidate",
				pullRequestMerge: { attempted: true, merged: true, result: mergeResult },
				projectStatusUpdate: {
					attempted: true,
					updated: false,
					targetStatus: input.status,
					error: message,
				},
			};
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		await createEvent(input.client, {
			runId: input.input.runId,
			attemptId: input.input.attemptId,
			level: "warn",
			type: "sandbox_codex_runner.pull_request_merge_failed",
			message: "Runner workflow could not merge the trusted pull request.",
			data: {
				pullRequest: input.handoff,
				error: message,
			},
		});

		return {
			action: "auto_merge_candidate",
			pullRequestMerge: { attempted: true, merged: false, error: message },
			projectStatusUpdate: { attempted: false },
		};
	}
}

async function moveProjectItemToHumanReview(input: {
	client: ReturnType<typeof createStateStoreClient>;
	config: ReturnType<typeof loadRhapsodyConfig>;
	input: RunnerWorkflowInput;
	handoff: RunnerWorkflowHandoff;
	issueNumber: number;
	decision: PostRunDecision;
	status: string;
}): Promise<RunnerWorkflowPostRunActionResult> {
	try {
		const statusResult = await updateProjectIssueStatus({
			owner: input.config.tracker.owner,
			repository: input.config.tracker.repository,
			projectNumber: input.config.tracker.projectNumber,
			statusField: input.config.tracker.statusField,
			issueNumber: input.issueNumber,
			status: input.status,
		});

		await createEvent(input.client, {
			runId: input.input.runId,
			attemptId: input.input.attemptId,
			level: "info",
			type: "sandbox_codex_runner.project_status_updated",
			message: `Runner workflow moved the Project item to ${input.status}.`,
			data: {
				issueNumber: input.issueNumber,
				toStatus: input.status,
				projectItemId: statusResult.itemId,
				fieldId: statusResult.fieldId,
				optionId: statusResult.optionId,
				pullRequestNumber: input.handoff.number,
				reason: input.decision.reason,
			},
		});

		return {
			action: "human_review",
			pullRequestMerge: { attempted: false },
			projectStatusUpdate: {
				attempted: true,
				updated: true,
				targetStatus: input.status,
				itemId: statusResult.itemId,
				fieldId: statusResult.fieldId,
				optionId: statusResult.optionId,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		await createEvent(input.client, {
			runId: input.input.runId,
			attemptId: input.input.attemptId,
			level: "warn",
				type: "sandbox_codex_runner.project_status_update_failed",
				message: `Runner workflow could not move the Project item to ${input.status}.`,
				data: {
					issueNumber: input.issueNumber,
					toStatus: input.status,
					error: message,
					pullRequestNumber: input.handoff.number,
					reason: input.decision.reason,
			},
		});

		return {
			action: "human_review",
			pullRequestMerge: { attempted: false },
			projectStatusUpdate: {
				attempted: true,
				updated: false,
				targetStatus: input.status,
				error: message,
			},
		};
	}
}

function evaluateFinalExecutionStatus(
	callbackPayload: RunnerWorkflowCallbackPayload,
	handoff: RunnerWorkflowHandoffResult,
) {
	if (callbackPayload.executionStatus === "completed") {
		return handoff.ok && handoff.pullRequest ? "completed" : "failed";
	}

	return callbackPayload.executionStatus;
}

function evaluateFinalError(
	callbackPayload: RunnerWorkflowCallbackPayload,
	handoff: RunnerWorkflowHandoffResult,
) {
	if (
		callbackPayload.executionStatus === "completed" &&
		(!handoff.ok || !handoff.pullRequest)
	) {
		if (!callbackPayload.branchName) {
			return "Runner completed execution, but callback did not include a branch name for PR handoff.";
		}

		if (!isPrSpec(callbackPayload.prSpec)) {
			return "Runner completed execution, but callback did not include a valid PR spec for handoff.";
		}

		if (!handoff.ok) {
			return `Runner completed execution, but trusted PR handoff failed: ${handoff.error}`;
		}

		return "Runner completed execution, but trusted PR handoff did not produce a pull request.";
	}

	return callbackPayload.error;
}

function isPrSpec(value: unknown): value is { title: string; body: string } {
	return (
		typeof value === "object" &&
		value !== null &&
		"title" in value &&
		"body" in value &&
		typeof (value as { title: unknown }).title === "string" &&
		(value as { title: string }).title.trim().length > 0 &&
		typeof (value as { body: unknown }).body === "string" &&
		(value as { body: string }).body.trim().length > 0
	);
}

function appendIssueReference(body: string, issueNumber: number | null) {
	if (issueNumber === null) {
		return body;
	}

	const reference = `Refs #${issueNumber}`;
	const issuePattern = new RegExp(
		`(?:refs|closes|fixes|resolves)\\s+#${issueNumber}(?!\\d)`,
		"iu",
	);

	if (issuePattern.test(body)) {
		return body;
	}

	return `${body.trimEnd()}\n\n${reference}`;
}

type RunnerPostflight = {
	changed_files?: unknown;
};

function extractChangedFiles(
	payload: RunnerWorkflowCallbackPayload,
): string[] | null {
	if (!payload.postflight || typeof payload.postflight !== "object") {
		return null;
	}

	const postflight = payload.postflight as RunnerPostflight;
	if (!Array.isArray(postflight.changed_files)) {
		return null;
	}

	return postflight.changed_files.filter((path) => typeof path === "string");
}
