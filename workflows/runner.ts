import { runAttemptExecution } from "@/lib/runners/registry";

export type RunnerWorkflowInput = {
	runId: string;
	attemptId: string;
	startedBy?: string;
	callbackBaseUrl?: string;
	networkPolicyVariant?: "oidc";
};

export type RunnerWorkflowOutput = {
	runId: string;
	attemptId: string;
	startedBy?: string;
	responseStatus: number;
	responseBody: string;
};

export async function runnerWorkflow(input: RunnerWorkflowInput) {
	"use workflow";

	return runRunnerAttempt(input);
}

async function runRunnerAttempt(input: RunnerWorkflowInput) {
	"use step";

	const callbackBaseUrl =
		input.callbackBaseUrl ??
		`https://${(process.env.VERCEL_URL ?? "localhost").replace(/^https?:\/\//, "")}`;
	const request = new Request(new URL("/", callbackBaseUrl), {
		method: "POST",
		body: JSON.stringify({
			callbackBaseUrl,
			networkPolicyVariant: input.networkPolicyVariant ?? "oidc",
		}),
	});
	const response = await runAttemptExecution({
		request,
		runId: input.runId,
		attemptId: input.attemptId,
		runner: null,
	});
	const responseBody = await response.text();

	return {
		runId: input.runId,
		attemptId: input.attemptId,
		startedBy: input.startedBy,
		responseStatus: response.status,
		responseBody,
	} satisfies RunnerWorkflowOutput;
}
