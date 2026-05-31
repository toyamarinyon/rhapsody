import { loadRhapsodyConfig } from "@/lib/config";
import {
	buildInstructionContext,
	loadRepositoryInstructions,
	renderRepositoryInstructions,
} from "@/lib/instructions";
import {
	applyAttemptTerminalCallback,
	createEvent,
	markAttemptStarted,
} from "@/lib/state";
import {
	buildAttemptBranchName,
	parseWorkItemIssueNumber,
} from "@/lib/attempt-branch";
import { type RunnerRouteContext } from "./types";

const FAKE_SANDBOX_ID = "fake_sandbox";
const FAKE_COMMAND = "fake-runner";
const PROMPT_PREVIEW_LENGTH = 500;

export async function runFakeRunner(
	context: RunnerRouteContext,
): Promise<Response> {
	const { client, runId, attemptId, detail, attempt } = context;

	if (
		isTerminalRunStatus(detail.run.status) ||
		isTerminalAttemptStatus(attempt.status)
	) {
		return Response.json({
			idempotent: true,
			runStatus: detail.run.status,
			attemptStatus: attempt.status,
			prompt: null,
		});
	}

	const config = loadRhapsodyConfig();
	const instructions = await loadRepositoryInstructions();
	const prompt = renderRepositoryInstructions({
		template: instructions.template,
		context: buildInstructionContext({ detail, attempt, config }),
	});
	const promptLength = prompt.length;
	const promptPreview = prompt.slice(0, PROMPT_PREVIEW_LENGTH);
	const promptEvent = await createEvent(client, {
		runId,
		attemptId,
		level: "info",
		type: "fake_runner.prompt_rendered",
		message: "Fake runner rendered prompt.",
		data: {
			instructionPath: instructions.instructionPath,
			promptLength,
			previewLength: promptPreview.length,
		},
	});
	const claimToken = detail.run.claimToken;
	const startResult = await markAttemptStarted(client, {
		runId,
		attemptId,
		gitBranchName: buildAttemptBranchName({
			branchPrefix: config.repository.branchPrefix,
			issueNumber: parseWorkItemIssueNumber({
				workItemId: detail.run.workItemId,
			}),
			attemptNumber: attempt.attemptNumber,
		}),
		claimToken,
		sandboxId: FAKE_SANDBOX_ID,
		command: FAKE_COMMAND,
	});
	const callbackResult = await applyAttemptTerminalCallback(client, {
		runId,
		attemptId,
		claimToken,
		executionStatus: "completed",
		exitCode: 0,
		sandboxId: FAKE_SANDBOX_ID,
		command: FAKE_COMMAND,
	});

	if (!callbackResult.applied) {
		return Response.json(
			{
				error: "Fake runner callback was not applied.",
				prompt: {
					instructionPath: instructions.instructionPath,
					length: promptLength,
					preview: promptPreview,
					eventId: promptEvent.id,
				},
				startResult,
				callbackResult,
			},
			{ status: 409 },
		);
	}

	return Response.json({
		prompt: {
			instructionPath: instructions.instructionPath,
			length: promptLength,
			preview: promptPreview,
			eventId: promptEvent.id,
		},
		startResult,
		callbackResult,
	});
}

function isTerminalRunStatus(status: string) {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "canceled" ||
		status === "timed_out" ||
		status === "stale"
	);
}

function isTerminalAttemptStatus(status: string) {
	return (
		status === "completed" ||
		status === "failed" ||
		status === "canceled" ||
		status === "timed_out" ||
		status === "stale"
	);
}
