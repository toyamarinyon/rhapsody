import { createStateStoreClient } from "@/lib/state";
import { runSchedulerTick } from "@/lib/scheduler/tick";
import { start } from "workflow/api";

import { runnerWorkflow } from "@/workflows/runner";

type SchedulerStartedRun = {
	workItemId: string;
	runId: string;
	attemptId: string;
	issueNumber: number;
	acquired: boolean;
	claimExpiresAt: number;
	runnerWorkflowRunId: string;
};

type SchedulerRunnerLaunch = {
	runId: string;
	attemptId: string;
	workflowRunId: string;
};

export async function schedulerWorkflow() {
	"use workflow";

	return runSchedulerTickStep();
}

async function runSchedulerTickStep() {
	"use step";

	const client = createStateStoreClient();

	try {
		const result = await runSchedulerTick(client);
		if (!result.ok) {
			return result;
		}

		const createdRunsWithWorkflow = await Promise.all(
			result.value.createdRuns.map(async (createdRun) => {
				const workflow = await start(runnerWorkflow, [
					{
						runId: createdRun.runId,
						attemptId: createdRun.attemptId,
						startedBy: "scheduler",
						networkPolicyVariant: "oidc",
					},
				]);
				const schedulerStartedRun: SchedulerStartedRun = {
					...createdRun,
					runnerWorkflowRunId: workflow.runId,
				};
				return schedulerStartedRun;
			}),
		);
		const runnerWorkflows: SchedulerRunnerLaunch[] = createdRunsWithWorkflow.map(
			(createdRun) => ({
				runId: createdRun.runId,
				attemptId: createdRun.attemptId,
				workflowRunId: createdRun.runnerWorkflowRunId,
			}),
		);

		return {
			ok: true,
			value: {
				...result.value,
				executed: runnerWorkflows.length > 0,
				execution: {
					triggered: runnerWorkflows.length > 0,
					reason:
						runnerWorkflows.length > 0
							? "Runner workflows started for created runs."
							: "No new runs were created; runner workflow start was skipped.",
				},
				createdRuns: createdRunsWithWorkflow,
				runnerWorkflows,
			},
		};
	} finally {
		client.close();
	}
}
