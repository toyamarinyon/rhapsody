import { loadRhapsodyMediatorEnv } from "@/lib/config";
import { isRecord, optionalString, readJson } from "@/lib/server/json";
import { applyAttemptTerminalCallback, createStateStoreClient } from "@/lib/state";

export const runtime = "nodejs";

type RunnerCallbackRequest = {
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
		const result = await applyAttemptTerminalCallback(client, {
			runId: parsed.value.runId,
			attemptId: parsed.value.attemptId,
			claimToken: parsed.value.claimToken,
			executionStatus: parsed.value.executionStatus,
			exitCode: parsed.value.exitCode,
			sandboxId: parsed.value.sandboxId,
			command: parsed.value.commandId,
			startedAt: parsed.value.startedAt,
			completedAt: parsed.value.completedAt,
			error: parsed.value.error,
		});

		if (!result.applied) {
			return Response.json(result, { status: 409 });
		}

		return Response.json(result, { status: result.idempotent ? 200 : 202 });
	} finally {
		client.close();
	}
}

function requireMediatorAuth(request: Request): { ok: true } | { ok: false; response: Response } {
	const env = loadRhapsodyMediatorEnv();

	if (request.headers.get("x-rhapsody-mediator-secret") !== env.MEDIATOR_SECRET) {
		return { ok: false, response: Response.json({ error: "Unauthorized." }, { status: 401 }) };
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

	const executionStatus = requiredString(value.execution_status, "execution_status");

	if (!executionStatus.ok) {
		return executionStatus;
	}

	const exitCode = optionalInteger(value.exit_code, "exit_code");

	if (!exitCode.ok) {
		return exitCode;
	}

	const sandboxId = optionalString(value.sandbox_id);

	if (sandboxId === undefined && "sandbox_id" in value) {
		return { ok: false, error: "sandbox_id must be a string or null when provided." };
	}

	const commandId = optionalString(value.command_id);

	if (commandId === undefined && "command_id" in value) {
		return { ok: false, error: "command_id must be a string or null when provided." };
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
		return { ok: false, error: "error must be a string or null when provided." };
	}

	return {
		ok: true,
		value: {
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
		},
	};
}

function requiredString(value: unknown, field: string): { ok: true; value: string } | { ok: false; error: string } {
	if (typeof value !== "string" || !value.trim()) {
		return { ok: false, error: `${field} must be a non-empty string.` };
	}

	return { ok: true, value };
}

function optionalInteger(
	value: unknown,
	field: string,
): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
	if (value === undefined || value === null) {
		return { ok: true, value };
	}

	if (typeof value !== "number" || !Number.isInteger(value)) {
		return { ok: false, error: `${field} must be an integer or null when provided.` };
	}

	return { ok: true, value };
}

function optionalTimestamp(
	value: unknown,
	field: string,
): { ok: true; value: number | null | undefined } | { ok: false; error: string } {
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

	return { ok: false, error: `${field} must be an epoch millisecond number, ISO timestamp, or null when provided.` };
}
