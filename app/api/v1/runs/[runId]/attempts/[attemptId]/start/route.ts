import { requireAdminAuth } from "@/lib/server/admin-auth";
import { isRecord, optionalString, readJson } from "@/lib/server/json";
import {
	createStateStoreClient,
	getRunDetail,
	markAttemptStarted,
	setRunnerWorkflowRunId,
} from "@/lib/state";
import {
	buildAttemptBranchName,
	parseWorkItemIssueNumber,
} from "@/lib/attempt-branch";
import { loadRhapsodyConfig } from "@/lib/config";
import { start } from "workflow/api";

import { runnerWorkflow } from "@/workflows/runner";

export const runtime = "nodejs";

type AttemptStartRequest = {
	claimToken: string;
	sandboxId?: string | null;
	command?: string | null;
	startedAt?: number | null;
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

	const parsed = parseAttemptStartRequest(body.value);

	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}

	const { runId, attemptId } = await context.params;
	const client = createStateStoreClient();
	const config = loadRhapsodyConfig();
	const detail = await getRunDetail(client, runId);
	const attempt = detail?.attempts.find(
		(candidate) => candidate.id === attemptId,
	);
	const issueNumber = detail
		? parseWorkItemIssueNumber({ workItemId: detail.run.workItemId })
		: null;
	const gitBranchName =
		detail && attempt
			? buildAttemptBranchName({
					branchPrefix: config.repository.branchPrefix,
					issueNumber,
					attemptNumber: attempt.attemptNumber,
				})
			: undefined;

	try {
		const result = await markAttemptStarted(client, {
			runId,
			attemptId,
			gitBranchName,
			claimToken: parsed.value.claimToken,
			sandboxId: parsed.value.sandboxId,
			command: parsed.value.command,
			startedAt: parsed.value.startedAt,
		});

		if (!result.applied) {
			return Response.json(result, { status: 409 });
		}

		const run = await getRunDetail(client, runId);
		if (result.idempotent && run?.run?.runnerWorkflowRunId) {
			return Response.json(
				{
					...result,
					runnerWorkflowRunId: run.run.runnerWorkflowRunId,
				},
				{ status: 200 },
			);
		}

		const workflow = await start(runnerWorkflow, [
			{
				runId,
				attemptId,
				startedBy: "manual",
				callbackBaseUrl: new URL(request.url).origin,
			},
		]);
		await setRunnerWorkflowRunId(client, {
			runId,
			runnerWorkflowRunId: workflow.runId,
		});

		return Response.json(
			{
				...result,
				runnerWorkflowRunId: workflow.runId,
			},
			{ status: result.idempotent ? 200 : 202 },
		);
	} finally {
		client.close();
	}
}

function parseAttemptStartRequest(
	value: unknown,
): { ok: true; value: AttemptStartRequest } | { ok: false; error: string } {
	if (!isRecord(value)) {
		return { ok: false, error: "Request body must be a JSON object." };
	}

	const claimToken = requiredString(value.claimToken, "claimToken");

	if (!claimToken.ok) {
		return claimToken;
	}

	const sandboxId = optionalString(value.sandboxId);

	if (sandboxId === undefined && "sandboxId" in value) {
		return {
			ok: false,
			error: "sandboxId must be a string or null when provided.",
		};
	}

	const command = optionalString(value.command);

	if (command === undefined && "command" in value) {
		return {
			ok: false,
			error: "command must be a string or null when provided.",
		};
	}

	const startedAt = optionalTimestamp(value.startedAt, "startedAt");

	if (!startedAt.ok) {
		return startedAt;
	}

	return {
		ok: true,
		value: {
			claimToken: claimToken.value,
			sandboxId,
			command,
			startedAt: startedAt.value,
		},
	};
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
