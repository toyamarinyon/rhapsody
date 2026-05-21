import { loadRhapsodyCronEnv } from "@/lib/config";
import { requireAdminAuth } from "@/lib/server/admin-auth";
import { getRun, start } from "workflow/api";

import { schedulerWorkflow } from "@/workflows/scheduler";

export const runtime = "nodejs";

export async function POST(request: Request) {
	const auth = requireCronOrAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	return startSchedulerTickWorkflow();
}

export async function GET(request: Request) {
	const auth = requireCronOrAdminAuth(request);

	if (!auth.ok) {
		return auth.response;
	}

	const url = new URL(request.url);
	const runId = url.searchParams.get("runId");

	if (!runId) {
		return startSchedulerTickWorkflow();
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

async function startSchedulerTickWorkflow() {
	const workflowRun = await start(schedulerWorkflow, []);

	return Response.json({
		started: true,
		workflowRunId: workflowRun.runId,
	});
}

function requireCronOrAdminAuth(request: Request) {
	const cronSecret = loadRhapsodyCronEnv().CRON_SECRET;
	const authorization = request.headers.get("authorization");

	if (cronSecret?.trim() && authorization === `Bearer ${cronSecret}`) {
		return { ok: true } as const;
	}

	return requireAdminAuth(request);
}
