import { requireAdminAuth } from "@/lib/server/admin-auth";
import { getRun, start } from "workflow/api";

import { schedulerWorkflow } from "@/workflows/scheduler";

export const runtime = "nodejs";

export async function POST(request: Request) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const workflowRun = await start(schedulerWorkflow, []);

	return Response.json({
		started: true,
		workflowRunId: workflowRun.runId,
	});
}

export async function GET(request: Request) {
	const auth = requireAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const url = new URL(request.url);
	const runId = url.searchParams.get("runId");

	if (!runId) {
		return Response.json({ error: "Missing runId." }, { status: 400 });
	}

	const run = getRun(runId);

	if (!(await run.exists)) {
		return Response.json({ error: "Workflow run not found." }, { status: 404 });
	}

	const status = await run.status;
	const response: { runId: string; status: string; returnValue?: unknown } = {
		runId,
		status,
	};

	if (status === "completed") {
		response.returnValue = await run.returnValue;
	}

	return Response.json(response);
}
