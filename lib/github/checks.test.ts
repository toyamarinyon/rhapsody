import { expect, test } from "vitest";
import { getPullRequestCheckSummary } from "./checks";

test("getPullRequestCheckSummary attaches GitHub Actions workflow, job, and failed step metadata", async () => {
	const summary = await getPullRequestCheckSummary(
		{
			owner: "toyamarinyon",
			repository: "rhapsody",
			pullRequestNumber: 79,
		},
		{ GITHUB_TOKEN: "test-token" },
		{
			octokit: {
				rest: {
					pulls: {
						get: async () =>
							({
								data: {
									number: 79,
									head: { sha: "sha-79" },
								},
							}) as never,
					},
					checks: {
						listForRef: async () =>
							({
								data: {
									check_runs: [
										{
											id: 901,
											name: "Static checks",
											status: "completed",
											conclusion: "failure",
											details_url:
												"https://github.com/toyamarinyon/rhapsody/actions/runs/123/job/456",
										},
									],
								},
							}) as never,
					},
					repos: {
						getCombinedStatusForRef: async () =>
							({
								data: {
									state: "failure",
								},
							}) as never,
					},
					actions: {
						getWorkflowRun: async () =>
							({
								data: {
									name: "CI",
									path: ".github/workflows/ci.yml",
								},
							}) as never,
						listJobsForWorkflowRun: async () =>
							({
								data: {
									jobs: [
										{
											id: 456,
											name: "Static checks",
											steps: [
												{ name: "Checkout", conclusion: "success" },
												{ name: "Format check", conclusion: "failure" },
											],
										},
									],
								},
								headers: {},
							}) as never,
					},
				},
			},
		},
	);

	expect(summary.classification).toBe("ci_failed");
	expect(summary.checkRuns).toEqual([
		{
			name: "Static checks",
			status: "completed",
			conclusion: "failure",
			detailsUrl:
				"https://github.com/toyamarinyon/rhapsody/actions/runs/123/job/456",
			actions: {
				workflowRunId: 123,
				workflowName: "CI",
				workflowPath: ".github/workflows/ci.yml",
				jobId: 456,
				jobName: "Static checks",
				failedStepNames: ["Format check"],
			},
		},
	]);
});
