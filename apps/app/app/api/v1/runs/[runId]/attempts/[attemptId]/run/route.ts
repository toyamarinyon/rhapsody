import { requireAdminAuth } from "@/lib/server/admin-auth";
import {
	createStateStoreClient,
	getRunDetail,
	setRunnerWorkflowRunId,
} from "@/lib/state";
import { start } from "workflow/api";

import { runnerWorkflow } from "@/workflows/runner";

export const runtime = "nodejs";

export async function POST(
	request: Request,
	context: { params: Promise<{ runId: string; attemptId: string }> },
) {
	const auth = await requireAdminAuth(request);

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

		const attempt = detail.attempts.find(
			(candidate) => candidate.id === attemptId,
		);

		if (!attempt) {
			return Response.json({ error: "Attempt not found." }, { status: 404 });
		}

		if (detail.run.runnerWorkflowRunId) {
			return Response.json({
				runnerWorkflowRunId: detail.run.runnerWorkflowRunId,
				started: false,
			});
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
				runnerWorkflowRunId: workflow.runId,
				started: true,
			},
			{ status: 202 },
		);
	} finally {
		client.close();
	}
}
