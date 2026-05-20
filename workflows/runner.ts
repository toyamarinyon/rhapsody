import { runAttemptExecution } from "@/lib/runners/registry";
import { loadRhapsodyConfig } from "@/lib/config";
import { createOrReuseOpenPullRequest } from "@/lib/github/pull-requests";
import { updateProjectIssueStatus } from "@/lib/github/project-items";
import { parseWorkItemIssueNumber } from "@/lib/attempt-branch";
import {
	decidePostRunAction,
	type PostRunDecision,
} from "@/lib/post-run-decision";
import {
	applyAttemptTerminalCallback,
	createEvent,
	createStateStoreClient,
	getRunDetail,
	type AttemptTransitionResult,
} from "@/lib/state";
import { buildAttemptHookToken } from "@/lib/workflows/attempt-hook";
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
	finalization: AttemptTransitionResult;
	postRunDecision: RunnerWorkflowPostRunDecisionResult;
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

export type RunnerWorkflowPostRunDecisionResult =
	| {
			ok: true;
			decision: PostRunDecision;
			projectStatusUpdate:
				| {
						applied: true;
						targetStatus: string;
						projectItemId: string;
						fieldId: string;
						optionId: string;
				  }
				| {
						applied: false;
						reason: "no_action";
				  };
	  }
	| {
			ok: false;
			decision: PostRunDecision;
			error: string;
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
	const postRunDecision = await runPostRunDecision(input, handoff, finalization);

	return {
		runId: input.runId,
		attemptId: input.attemptId,
		startedBy: input.startedBy,
		responseStatus: launched.responseStatus,
		responseBody: launched.responseBody,
		hookToken: launched.hookToken,
		callbackPayload,
		handoff,
		finalization,
		postRunDecision,
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
		throw new Error(`Runner launch failed with HTTP ${response.status}: ${responseBody}`);
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
		const handoff = await createOrReuseOpenPullRequest({
			owner: config.repository.owner,
			repository: config.repository.name,
			base: config.repository.defaultBranch,
			head: callbackPayload.branchName,
			title: callbackPayload.prSpec.title,
			body: callbackPayload.prSpec.body,
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
			message: "Runner workflow could not create or reuse a pull request for handoff.",
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

async function runPostRunDecision(
	input: RunnerWorkflowInput,
	handoff: RunnerWorkflowHandoffResult,
	finalization: AttemptTransitionResult,
): Promise<RunnerWorkflowPostRunDecisionResult> {
	"use step";

	const decision = decidePostRunAction({
		runStatus: finalization.applied ? finalization.runStatus : "not_applied",
		attemptStatus: finalization.applied ? finalization.attemptStatus : "not_applied",
		verifiedPullRequest: handoff.ok ? handoff.pullRequest : null,
	});
	const client = createStateStoreClient();

	try {
		await createEvent(client, {
			runId: input.runId,
			attemptId: input.attemptId,
			level: decision.outcome === "requires_human_review" ? "info" : "warn",
			type: "post_run_decision.evaluated",
			message: "Runner workflow evaluated post-run decision policy.",
			data: {
				outcome: decision.outcome,
				action: decision.action,
				reason: decision.reason,
				targetProjectStatus: decision.targetProjectStatus,
				pullRequest: decision.pullRequest,
				futureReviewEvidence: decision.futureReviewEvidence,
				finalization,
			},
		});

		if (decision.action === "none") {
			await createEvent(client, {
				runId: input.runId,
				attemptId: input.attemptId,
				level: "warn",
				type: "post_run_decision.no_project_status_action",
				message: "Post-run decision did not move the Project item.",
				data: {
					outcome: decision.outcome,
					reason: decision.reason,
					handoff,
					finalization,
				},
			});

			return {
				ok: true,
				decision,
				projectStatusUpdate: { applied: false, reason: "no_action" },
			};
		}

		const config = loadRhapsodyConfig();
		const detail = await getRunDetail(client, input.runId);
		const issueNumber = detail
			? parseWorkItemIssueNumber({ workItemId: detail.run.workItemId })
			: null;

		if (!issueNumber) {
			const error = "Post-run decision could not resolve the issue number for Project status movement.";

			await createEvent(client, {
				runId: input.runId,
				attemptId: input.attemptId,
				level: "error",
				type: "post_run_decision.project_status_update_failed",
				message: "Post-run decision could not move the Project item.",
				data: {
					outcome: decision.outcome,
					targetProjectStatus: decision.targetProjectStatus,
					error,
				},
			});

			return { ok: false, decision, error };
		}

		const update = await updateProjectIssueStatus({
			owner: config.tracker.owner,
			repository: config.tracker.repository,
			projectNumber: config.tracker.projectNumber,
			statusField: config.tracker.statusField,
			issueNumber,
			status: decision.targetProjectStatus,
		});

		await createEvent(client, {
			runId: input.runId,
			attemptId: input.attemptId,
			level: "info",
			type: "post_run_decision.project_status_updated",
			message: "Post-run decision moved the Project item.",
			data: {
				outcome: decision.outcome,
				action: decision.action,
				reason: decision.reason,
				issueNumber,
				toStatus: decision.targetProjectStatus,
				projectItemId: update.itemId,
				fieldId: update.fieldId,
				optionId: update.optionId,
				pullRequest: decision.pullRequest,
			},
		});

		return {
			ok: true,
			decision,
			projectStatusUpdate: {
				applied: true,
				targetStatus: update.status,
				projectItemId: update.itemId,
				fieldId: update.fieldId,
				optionId: update.optionId,
			},
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		await createEvent(client, {
			runId: input.runId,
			attemptId: input.attemptId,
			level: "error",
			type: "post_run_decision.project_status_update_failed",
			message: "Post-run decision could not move the Project item.",
			data: {
				outcome: decision.outcome,
				targetProjectStatus: decision.targetProjectStatus,
				error: message,
			},
		});

		return { ok: false, decision, error: message };
	} finally {
		client.close();
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
	if (callbackPayload.executionStatus === "completed" && (!handoff.ok || !handoff.pullRequest)) {
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
