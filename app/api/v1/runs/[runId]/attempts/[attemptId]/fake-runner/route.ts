import { loadRhapsodyConfig } from "@/lib/config";
import {
	buildInstructionContext,
	InstructionTemplateError,
	loadRepositoryInstructions,
	renderRepositoryInstructions,
} from "@/lib/instructions";
import { requireAdminAuth } from "@/lib/server/admin-auth";
import {
	applyAttemptTerminalCallback,
	createEvent,
	createStateStoreClient,
	getRunDetail,
	markAttemptStarted,
} from "@/lib/state";

export const runtime = "nodejs";

const FAKE_SANDBOX_ID = "fake_sandbox";
const FAKE_COMMAND = "fake-runner";
const PROMPT_PREVIEW_LENGTH = 500;

export async function POST(
	request: Request,
	context: { params: Promise<{ runId: string; attemptId: string }> },
) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const { runId, attemptId } = await context.params;
	const client = createStateStoreClient();

	try {
		const detail = await getRunDetail(client, runId);

		if (!detail) {
			return Response.json({ error: "Run not found." }, { status: 404 });
		}

		const attempt = detail.attempts.find((candidate) => candidate.id === attemptId);

		if (!attempt) {
			return Response.json({ error: "Attempt not found." }, { status: 404 });
		}

		if (isTerminalRunStatus(detail.run.status) || isTerminalAttemptStatus(attempt.status)) {
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
	} catch (error) {
		if (error instanceof InstructionTemplateError) {
			return Response.json({ error: error.message }, { status: 422 });
		}

		throw error;
	} finally {
		client.close();
	}
}

function isTerminalRunStatus(status: string) {
	return status === "completed" || status === "failed" || status === "canceled" || status === "timed_out" || status === "stale";
}

function isTerminalAttemptStatus(status: string) {
	return status === "completed" || status === "failed" || status === "canceled" || status === "timed_out" || status === "stale";
}
