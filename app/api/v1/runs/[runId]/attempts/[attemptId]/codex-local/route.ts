import {
	buildCodexExecCommand,
	type CodexCliResult,
	runCodexExec,
} from "@/lib/codex/cli";
import { loadRhapsodyConfig } from "@/lib/config";
import {
	buildInstructionContext,
	InstructionTemplateError,
	loadRepositoryInstructions,
	renderRepositoryInstructions,
} from "@/lib/instructions";
import { requireAdminAuth } from "@/lib/server/admin-auth";
import { isRecord, readJson } from "@/lib/server/json";
import {
	applyAttemptTerminalCallback,
	createEvent,
	createStateStoreClient,
	getRunDetail,
	markAttemptStarted,
} from "@/lib/state";

export const runtime = "nodejs";

const CODEX_LOCAL_SANDBOX_ID = "local_dev_codex";
const CODEX_LOCAL_COMMAND = "codex exec";
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const PROMPT_PREVIEW_LENGTH = 500;
const RESULT_PREVIEW_LENGTH = 500;

type CodexLocalRequest = {
	mode: "dry_run" | "execute";
	confirm?: string;
	timeoutMs: number;
};

export async function POST(
	request: Request,
	context: { params: Promise<{ runId: string; attemptId: string }> },
) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const body = await readJson(request);

	if (!body.ok) {
		return body.response;
	}

	const parsed = parseCodexLocalRequest(body.value);

	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	if (parsed.value.mode === "execute" && parsed.value.confirm !== "run-codex-local") {
		return Response.json({ error: "confirm must be \"run-codex-local\" for execute mode." }, { status: 400 });
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

		const config = loadRhapsodyConfig();
		const instructions = await loadRepositoryInstructions();
		const prompt = renderRepositoryInstructions({
			template: instructions.template,
			context: buildInstructionContext({ detail, attempt, config }),
		});
		const cwd = process.cwd();
		const commandOptions = {
			cwd,
			prompt,
			sandboxMode: "workspace-write" as const,
			approvalPolicy: "never" as const,
			json: true,
			timeoutMs: parsed.value.timeoutMs,
		};
		const command = buildCodexExecCommand(commandOptions);
		const promptSummary = {
			instructionPath: instructions.instructionPath,
			length: prompt.length,
			preview: prompt.slice(0, PROMPT_PREVIEW_LENGTH),
		};

		if (parsed.value.mode === "dry_run") {
			return Response.json({
				mode: "dry_run",
				command,
				cwd,
				timeoutMs: parsed.value.timeoutMs,
				prompt: promptSummary,
			});
		}

		if (isTerminalRunStatus(detail.run.status) || isTerminalAttemptStatus(attempt.status)) {
			return Response.json({
				idempotent: true,
				runStatus: detail.run.status,
				attemptStatus: attempt.status,
				prompt: promptSummary,
			});
		}

		const claimToken = detail.run.claimToken;
		const startResult = await markAttemptStarted(client, {
			runId,
			attemptId,
			claimToken,
			sandboxId: CODEX_LOCAL_SANDBOX_ID,
			command: CODEX_LOCAL_COMMAND,
		});

		if (!startResult.applied) {
			return Response.json({ error: "Attempt could not be started.", startResult }, { status: 409 });
		}

		const beforeEvent = await createEvent(client, {
			runId,
			attemptId,
			level: "info",
			type: "codex_local.execution_started",
			message: "Local Codex execution started.",
			data: {
				command: command.argv,
				cwd,
				timeoutMs: parsed.value.timeoutMs,
				promptLength: prompt.length,
			},
		});
		const codexResult = await runCodexExec(commandOptions);
		const codexSummary = summarizeCodexResult(codexResult);
		const afterEvent = await createEvent(client, {
			runId,
			attemptId,
			level: codexResult.exitCode === 0 && !codexResult.timedOut ? "info" : "error",
			type: "codex_local.execution_finished",
			message: "Local Codex execution finished.",
			data: codexSummary,
		});
		const callbackResult = await applyAttemptTerminalCallback(client, {
			runId,
			attemptId,
			claimToken,
			executionStatus: codexResult.timedOut ? "timed_out" : codexResult.exitCode === 0 ? "completed" : "failed",
			exitCode: codexResult.exitCode,
			sandboxId: CODEX_LOCAL_SANDBOX_ID,
			command: CODEX_LOCAL_COMMAND,
			error: codexResult.error,
		});

		if (!callbackResult.applied) {
			return Response.json(
				{
					error: "Local Codex callback was not applied.",
					prompt: promptSummary,
					startResult,
					codexResult: codexSummary,
					events: { beforeEventId: beforeEvent.id, afterEventId: afterEvent.id },
					callbackResult,
				},
				{ status: 409 },
			);
		}

		return Response.json({
			mode: "execute",
			prompt: promptSummary,
			startResult,
			codexResult: codexSummary,
			events: { beforeEventId: beforeEvent.id, afterEventId: afterEvent.id },
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

function parseCodexLocalRequest(
	value: unknown,
): { ok: true; value: CodexLocalRequest } | { ok: false; error: string } {
	if (!isRecord(value)) {
		return { ok: false, error: "Request body must be a JSON object." };
	}

	const mode = value.mode === undefined ? "dry_run" : value.mode;

	if (mode !== "dry_run" && mode !== "execute") {
		return { ok: false, error: "mode must be \"dry_run\" or \"execute\" when provided." };
	}

	const timeoutMs = optionalTimeoutMs(value.timeoutMs);

	if (!timeoutMs.ok) {
		return timeoutMs;
	}

	return {
		ok: true,
		value: {
			mode,
			confirm: typeof value.confirm === "string" ? value.confirm : undefined,
			timeoutMs: timeoutMs.value,
		},
	};
}

function optionalTimeoutMs(
	value: unknown,
): { ok: true; value: number } | { ok: false; error: string } {
	if (value === undefined || value === null) {
		return { ok: true, value: DEFAULT_TIMEOUT_MS };
	}

	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
		return { ok: false, error: "timeoutMs must be a positive integer when provided." };
	}

	return { ok: true, value: Math.min(value, MAX_TIMEOUT_MS) };
}

function summarizeCodexResult(result: CodexCliResult) {
	return {
		exitCode: result.exitCode,
		signal: result.signal,
		timedOut: result.timedOut,
		durationMs: result.durationMs,
		stdoutLength: result.stdout.length,
		stdoutPreview: previewOutput(result.stdout),
		stderrLength: result.stderr.length,
		stderrPreview: previewOutput(result.stderr),
		error: result.error,
	};
}

function previewOutput(value: string) {
	return value.slice(0, RESULT_PREVIEW_LENGTH);
}

function isTerminalRunStatus(status: string) {
	return status === "completed" || status === "failed" || status === "canceled" || status === "timed_out" || status === "stale";
}

function isTerminalAttemptStatus(status: string) {
	return status === "completed" || status === "failed" || status === "canceled" || status === "timed_out" || status === "stale";
}
