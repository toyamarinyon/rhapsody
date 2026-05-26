import { resumeHook } from "workflow/api";
import { loadRhapsodyMediatorEnv } from "@/lib/config";
import { isRecord, optionalString, readJson } from "@/lib/server/json";
import {
	createEvent,
	createStateStoreClient,
	validateAttemptCanReceiveCallback,
} from "@/lib/state";
import { buildAttemptHookToken } from "@/lib/workflows/attempt-hook";

export const runtime = "nodejs";

type RunnerCallbackRequest = {
	callbackType: "terminal" | "progress";
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
	hookToken?: string | null;
	branchName?: string | null;
	prSpec?: unknown;
	postflight?: unknown;
	diagnostics?: unknown;
};

export async function POST(request: Request) {
	const auth = requireMediatorAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const body = await readJson(request);

	if (!body.ok) {
		return body.response;
	}

	const parsed = parseRunnerCallbackRequest(body.value);

	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	const client = createStateStoreClient();

	try {
		const acceptance = await validateAttemptCanReceiveCallback(client, {
			runId: parsed.value.runId,
			attemptId: parsed.value.attemptId,
			claimToken: parsed.value.claimToken,
			sandboxId: parsed.value.sandboxId,
		});

		if (!acceptance.ok) {
			const terminalDuplicate =
				acceptance.reason === "attempt_terminal" ||
				acceptance.reason === "run_terminal";

			return Response.json(
				{
					accepted: terminalDuplicate,
					idempotent: terminalDuplicate,
					workflowResume: {
						resumed: false,
						skipped: terminalDuplicate,
						reason: acceptance.reason,
					},
					...acceptance,
				},
				{ status: terminalDuplicate ? 200 : 409 },
			);
		}

		if (parsed.value.callbackType === "progress") {
			const event = await createEvent(client, {
				runId: parsed.value.runId,
				attemptId: parsed.value.attemptId,
				level: "info",
				type: "attempt.progress",
				message: "Attempt progress callback received.",
				data: buildProgressEventPayload(parsed.value),
			});

			return Response.json(
				{
					accepted: true,
					idempotent: false,
					eventId: event.id,
					runStatus: acceptance.runStatus,
					attemptStatus: acceptance.attemptStatus,
					workflowResume: {
						resumed: false,
						skipped: true,
						reason: "progress_callback",
					},
				},
				{ status: 202 },
			);
		}

		const event = await createEvent(client, {
			runId: parsed.value.runId,
			attemptId: parsed.value.attemptId,
			level: parsed.value.executionStatus === "completed" ? "info" : "warn",
			type: "attempt.callback_received",
			message:
				"Attempt callback received; runner workflow will evaluate final status.",
			data: buildCallbackEventPayload(parsed.value),
		});
		const workflowResume = await resumeAttemptHook(parsed.value);

		if (!workflowResume.resumed && !("skipped" in workflowResume)) {
			await createEvent(client, {
				runId: parsed.value.runId,
				attemptId: parsed.value.attemptId,
				level: "warn",
				type: "attempt.workflow_resume_failed",
				message:
					"Attempt terminal callback was stored, but workflow hook resume failed.",
				data: workflowResume,
			});
		}

		return Response.json(
			{
				accepted: true,
				idempotent: false,
				eventId: event.id,
				runStatus: acceptance.runStatus,
				attemptStatus: acceptance.attemptStatus,
				workflowResume,
			},
			{ status: 202 },
		);
	} finally {
		client.close();
	}
}

function buildCallbackEventPayload(callback: RunnerCallbackRequest) {
	return {
		callbackType: callback.callbackType,
		executionStatus: callback.executionStatus,
		exitCode: callback.exitCode ?? null,
		sandboxId: callback.sandboxId ?? null,
		commandId: callback.commandId ?? null,
		startedAt: callback.startedAt ?? null,
		completedAt: callback.completedAt ?? null,
		error: callback.error ?? null,
		hookToken: callback.hookToken ?? buildAttemptHookToken(callback.attemptId),
		branchName: callback.branchName ?? null,
		prSpec: callback.prSpec ?? null,
		postflight: callback.postflight ?? null,
		diagnostics: sanitizeDiagnostics(callback.diagnostics),
	};
}

function buildProgressEventPayload(callback: RunnerCallbackRequest) {
	return {
		callbackType: callback.callbackType,
		executionStatus: callback.executionStatus,
		exitCode: callback.exitCode ?? null,
		sandboxId: callback.sandboxId ?? null,
		commandId: callback.commandId ?? null,
		startedAt: callback.startedAt ?? null,
		completedAt: callback.completedAt ?? null,
		error: callback.error ? redactAndBound(callback.error, 500) : null,
		diagnostics: sanitizeDiagnostics(callback.diagnostics),
	};
}

async function resumeAttemptHook(callback: RunnerCallbackRequest) {
	const hookToken =
		callback.hookToken ?? buildAttemptHookToken(callback.attemptId);

	try {
		const hook = await resumeHook(hookToken, {
			runId: callback.runId,
			attemptId: callback.attemptId,
			claimToken: callback.claimToken,
			executionStatus: callback.executionStatus,
			exitCode: callback.exitCode,
			sandboxId: callback.sandboxId,
			commandId: callback.commandId,
			startedAt: callback.startedAt,
			completedAt: callback.completedAt,
			error: callback.error,
			branchName: callback.branchName,
			prSpec: callback.prSpec,
			postflight: callback.postflight,
		});

		return {
			resumed: true,
			hookToken,
			workflowRunId: hook.runId,
		};
	} catch (error) {
		return {
			resumed: false,
			hookToken,
			error: serializeError(error),
		};
	}
}

function requireMediatorAuth(
	request: Request,
): { ok: true } | { ok: false; response: Response } {
	const env = loadRhapsodyMediatorEnv();

	if (
		request.headers.get("x-rhapsody-mediator-secret") !== env.MEDIATOR_SECRET
	) {
		return {
			ok: false,
			response: Response.json({ error: "Unauthorized." }, { status: 401 }),
		};
	}

	return { ok: true };
}

function parseRunnerCallbackRequest(
	value: unknown,
): { ok: true; value: RunnerCallbackRequest } | { ok: false; error: string } {
	if (!isRecord(value)) {
		return { ok: false, error: "Request body must be a JSON object." };
	}

	const runId = requiredString(value.run_id, "run_id");

	if (!runId.ok) {
		return runId;
	}

	const attemptId = requiredString(value.attempt_id, "attempt_id");

	if (!attemptId.ok) {
		return attemptId;
	}

	const claimToken = requiredString(value.claim_token, "claim_token");

	if (!claimToken.ok) {
		return claimToken;
	}

	const executionStatus = requiredString(
		value.execution_status,
		"execution_status",
	);

	if (!executionStatus.ok) {
		return executionStatus;
	}

	const exitCode = optionalInteger(value.exit_code, "exit_code");

	if (!exitCode.ok) {
		return exitCode;
	}

	const sandboxId = optionalString(value.sandbox_id);

	if (sandboxId === undefined && "sandbox_id" in value) {
		return {
			ok: false,
			error: "sandbox_id must be a string or null when provided.",
		};
	}

	const commandId = optionalString(value.command_id);

	if (commandId === undefined && "command_id" in value) {
		return {
			ok: false,
			error: "command_id must be a string or null when provided.",
		};
	}

	const startedAt = optionalTimestamp(value.started_at, "started_at");

	if (!startedAt.ok) {
		return startedAt;
	}

	const completedAt = optionalTimestamp(value.completed_at, "completed_at");

	if (!completedAt.ok) {
		return completedAt;
	}

	const error = optionalString(value.error);

	if (error === undefined && "error" in value) {
		return {
			ok: false,
			error: "error must be a string or null when provided.",
		};
	}
	const hookToken = optionalString(value.hook_token);

	if (hookToken === undefined && "hook_token" in value) {
		return {
			ok: false,
			error: "hook_token must be a string or null when provided.",
		};
	}
	const branchName = optionalString(value.branch_name);

	if (branchName === undefined && "branch_name" in value) {
		return {
			ok: false,
			error: "branch_name must be a string or null when provided.",
		};
	}
	const callbackType = parseCallbackType(value.callback_type);

	if (!callbackType.ok) {
		return callbackType;
	}

	return {
		ok: true,
		value: {
			callbackType: callbackType.value,
			runId: runId.value,
			attemptId: attemptId.value,
			claimToken: claimToken.value,
			executionStatus: executionStatus.value,
			exitCode: exitCode.value,
			sandboxId,
			commandId,
			startedAt: startedAt.value,
			completedAt: completedAt.value,
			error,
			hookToken,
			branchName,
			prSpec: value.pr_spec,
			postflight: value.postflight,
			diagnostics: value.diagnostics,
		},
	};
}

function parseCallbackType(
	value: unknown,
): { ok: true; value: "terminal" | "progress" } | { ok: false; error: string } {
	if (value === undefined || value === null) {
		return { ok: true, value: "terminal" };
	}

	if (value === "terminal" || value === "progress") {
		return { ok: true, value };
	}

	return {
		ok: false,
		error: 'callback_type must be "terminal", "progress", null, or omitted.',
	};
}

const DIAGNOSTIC_PREVIEW_LENGTH = 1000;

function sanitizeDiagnostics(value: unknown) {
	if (!isRecord(value)) {
		return null;
	}

	return {
		stdoutTail:
			typeof value.stdout_tail === "string"
				? redactAndBound(value.stdout_tail, DIAGNOSTIC_PREVIEW_LENGTH)
				: null,
		stderrTail:
			typeof value.stderr_tail === "string"
				? redactAndBound(value.stderr_tail, DIAGNOSTIC_PREVIEW_LENGTH)
				: null,
		stdoutBytes:
			typeof value.stdout_bytes === "number" &&
			Number.isFinite(value.stdout_bytes)
				? value.stdout_bytes
				: null,
		stderrBytes:
			typeof value.stderr_bytes === "number" &&
			Number.isFinite(value.stderr_bytes)
				? value.stderr_bytes
				: null,
		lastOutputAt: optionalIsoString(value.last_output_at),
		lastStdoutAt: optionalIsoString(value.last_stdout_at),
		lastStderrAt: optionalIsoString(value.last_stderr_at),
		lastCodexEventType:
			typeof value.last_codex_event_type === "string"
				? redactAndBound(value.last_codex_event_type, 120)
				: null,
		lastCodexError:
			typeof value.last_codex_error === "string"
				? redactAndBound(value.last_codex_error, 500)
				: null,
	};
}

function optionalIsoString(value: unknown) {
	if (typeof value !== "string" || !value.trim()) {
		return null;
	}

	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function redactAndBound(value: string, limit: number) {
	return value
		.replace(
			/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|AUTH)[A-Z0-9_]*\s*[=:]\s*)[^\s"',;]+/gi,
			"$1[REDACTED]",
		)
		.replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
		.replace(/(sk-[A-Za-z0-9_-]{8,})/g, "[REDACTED]")
		.slice(0, limit);
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}

	return { name: "UnknownError", message: String(error) };
}

function requiredString(
	value: unknown,
	field: string,
): { ok: true; value: string } | { ok: false; error: string } {
	if (typeof value !== "string" || !value.trim()) {
		return { ok: false, error: `${field} must be a non-empty string.` };
	}

	return { ok: true, value };
}

function optionalInteger(
	value: unknown,
	field: string,
):
	| { ok: true; value: number | null | undefined }
	| { ok: false; error: string } {
	if (value === undefined || value === null) {
		return { ok: true, value };
	}

	if (typeof value !== "number" || !Number.isInteger(value)) {
		return {
			ok: false,
			error: `${field} must be an integer or null when provided.`,
		};
	}

	return { ok: true, value };
}

function optionalTimestamp(
	value: unknown,
	field: string,
):
	| { ok: true; value: number | null | undefined }
	| { ok: false; error: string } {
	if (value === undefined || value === null) {
		return { ok: true, value };
	}

	if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
		return { ok: true, value };
	}

	if (typeof value === "string" && value.trim()) {
		const timestamp = Date.parse(value);

		if (Number.isFinite(timestamp)) {
			return { ok: true, value: timestamp };
		}
	}

	return {
		ok: false,
		error: `${field} must be an epoch millisecond number, ISO timestamp, or null when provided.`,
	};
}
