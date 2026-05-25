import { createHook } from "workflow";
import { parseWorkItemIssueNumber } from "@/lib/attempt-branch";
import { loadRhapsodyConfig } from "@/lib/config";
import { appendIssueReference } from "@/lib/github/issue-reference";
import { createOrReuseOpenPullRequest } from "@/lib/github/pull-requests";
import { runAttemptExecution } from "@/lib/runners/registry";
import {
	type AttemptTransitionResult,
	applyAttemptTerminalCallback,
	createArtifact,
	createDecision,
	createEvent,
	createLink,
	createStateStoreClient,
	getRunDetail,
	updateWorkerRunStatus,
} from "@/lib/state";
import { buildAttemptHookToken } from "@/lib/workflows/attempt-hook";

export type RunnerWorkflowInput = {
	runId: string;
	attemptId: string;
	builderWorkerRunId?: string;
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

export async function runnerWorkflow(input: RunnerWorkflowInput) {
	"use workflow";

	const hookToken = buildAttemptHookToken(input.attemptId);
	const hook = createHook<RunnerWorkflowCallbackPayload>({
		token: hookToken,
	});
	const launched = await runRunnerAttempt(input, hookToken);
	if (input.builderWorkerRunId) {
		await markWorkerRunStatusRunning(input);
	}
	const callbackPayload = await hook;
	const handoff = await completeRunnerHandoff(input, callbackPayload);
	const finalization = await finalizeRunnerAttempt(callbackPayload, handoff);
	if (input.builderWorkerRunId) {
		await recordBuilderOutcome(input, callbackPayload, handoff, finalization);
	}

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
			builderWorkerRunId: input.builderWorkerRunId,
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
			body: appendIssueReference(callbackPayload.prSpec.body, issueNumber, {
				owner: config.repository.owner,
				name: config.repository.name,
			}),
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

async function markWorkerRunStatusRunning(input: RunnerWorkflowInput) {
	"use step";

	if (!input.builderWorkerRunId) {
		return;
	}

	const client = createStateStoreClient();
	try {
		await updateWorkerRunStatus(client, {
			id: input.builderWorkerRunId,
			status: "running",
			startedAt: Date.now(),
		});
	} catch (error) {
		await createEvent(client, {
			runId: input.runId,
			attemptId: input.attemptId,
			level: "warn",
			type: "sandbox_codex_runner.builder_worker_graph_failed",
			message:
				"Runner workflow could not mark builder worker graph run as running; continuing legacy runner flow.",
			data: {
				error: error instanceof Error ? error.message : String(error),
				builderWorkerRunId: input.builderWorkerRunId,
			},
		});
	} finally {
		client.close();
	}
}

async function recordBuilderOutcome(
	input: RunnerWorkflowInput,
	callbackPayload: RunnerWorkflowCallbackPayload,
	handoff: RunnerWorkflowHandoffResult,
	finalization: AttemptTransitionResult,
) {
	"use step";

	if (!input.builderWorkerRunId) {
		return;
	}

	const client = createStateStoreClient();
	try {
		const detail = await getRunDetail(client, input.runId);
		const workItemId = detail?.run?.workItemId;
		if (!workItemId) {
			throw new Error(
				`Could not resolve legacy run detail for builder outcome: ${input.runId}`,
			);
		}

		await createDecision(client, {
			workItemId,
			workerRunId: input.builderWorkerRunId,
			phase: "handoff",
			outcome: builderOutcomeFromResult({
				callbackPayload,
				handoff,
				finalization,
			}),
			deterministic: true,
			nextWorkerKind: null,
			evidence: {
				executionStatus: callbackPayload.executionStatus,
				branchName: callbackPayload.branchName,
				prHandoff: handoff.ok ? "success" : "missing_or_failed",
				finalization,
			},
		});

		if (callbackPayload.branchName) {
			const branchArtifactId = await createArtifact(client, {
				workItemId,
				workerRunId: input.builderWorkerRunId,
				kind: "branch",
				externalId: callbackPayload.branchName,
				metadata: {
					branchName: callbackPayload.branchName,
					executionStatus: callbackPayload.executionStatus,
					executedBy: input.startedBy ?? "scheduler",
				},
				snapshot: {
					branchName: callbackPayload.branchName,
				},
			});

			await createLink(client, {
				workItemId,
				fromNodeType: "worker_run",
				fromNodeId: input.builderWorkerRunId,
				toNodeType: "artifact",
				toNodeId: branchArtifactId,
				relation: "produced",
				metadata: {
					artifactKind: "branch",
				},
			});
		}

		if (handoff.ok && handoff.pullRequest) {
			const artifactId = await createArtifact(client, {
				workItemId,
				workerRunId: input.builderWorkerRunId,
				kind: "pull_request",
				externalId: String(handoff.pullRequest.number),
				externalUrl: handoff.pullRequest.htmlUrl,
				metadata: {
					pullRequestNumber: handoff.pullRequest.number,
					baseRef: handoff.pullRequest.baseRef,
					headRef: handoff.pullRequest.headRef,
				},
				snapshot: {
					title: handoff.pullRequest.title,
					headRef: handoff.pullRequest.headRef,
					baseRef: handoff.pullRequest.baseRef,
				},
			});

			await createLink(client, {
				workItemId,
				fromNodeType: "worker_run",
				fromNodeId: input.builderWorkerRunId,
				toNodeType: "artifact",
				toNodeId: artifactId,
				relation: "produced",
				metadata: {
					artifactKind: "pull_request",
				},
			});
		}

		await updateWorkerRunStatus(client, {
			id: input.builderWorkerRunId,
			status: builderRunFinalStatusFromAttemptResult(finalization),
		});
	} catch (error) {
		await createEvent(client, {
			runId: input.runId,
			attemptId: input.attemptId,
			level: "warn",
			type: "sandbox_codex_runner.builder_worker_graph_failed",
			message:
				"Runner workflow could not persist builder worker graph outcome for handoff/finalization.",
			data: {
				error: error instanceof Error ? error.message : String(error),
				builderWorkerRunId: input.builderWorkerRunId,
			},
		});
	} finally {
		client.close();
	}
}

function builderOutcomeFromResult(input: {
	callbackPayload: RunnerWorkflowCallbackPayload;
	handoff: RunnerWorkflowHandoffResult;
	finalization: AttemptTransitionResult;
}) {
	if (
		typeof input.finalization === "object" &&
		"applied" in input.finalization &&
		input.finalization.applied &&
		input.finalization.runStatus === "completed" &&
		input.handoff.ok &&
		input.handoff.pullRequest
	) {
		return "pr_created";
	}

	if (
		input.callbackPayload.executionStatus === "completed" &&
		(!input.handoff.ok || !input.handoff.pullRequest)
	) {
		return "no_pr_handoff";
	}

	return "builder_failed";
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

function builderRunFinalStatusFromAttemptResult(
	result: AttemptTransitionResult,
): "completed" | "failed" | "timed_out" | "canceled" | "stale" {
	if (
		typeof result === "object" &&
		result !== null &&
		"applied" in result &&
		result.applied &&
		result.runStatus
	) {
		switch (result.runStatus) {
			case "completed":
			case "failed":
			case "timed_out":
			case "canceled":
			case "stale":
				return result.runStatus;
			default:
				return "failed";
		}
	}

	return "failed";
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
