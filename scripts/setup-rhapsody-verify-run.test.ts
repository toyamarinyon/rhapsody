import { expect, test } from "vitest";
import {
	buildEvidenceSignals,
	buildNextActionsFromEvidence,
} from "@/scripts/setup-rhapsody-verify-run";

test("extracts PR evidence, handoff flags, and next actions from run detail", () => {
	const detail = {
		run: {
			status: "completed",
			runnerWorkflowRunId: "wf_abc",
		},
		attempts: [
			{
				id: "attempt-2",
				status: "failed",
				updatedAt: 1700,
			},
			{
				id: "attempt-3",
				status: "success",
				updatedAt: 1720,
			},
		],
		artifacts: [
			{
				kind: "pull_request",
				externalUrl: "https://github.com/acme/repo/pull/12",
				pullRequestNumber: "12",
				updatedAt: 1710,
			},
			{
				kind: "branch",
				externalUrl: "https://github.com/acme/repo/tree/feature-run",
				updatedAt: 1715,
			},
		],
		links: [
			{
				type: "artifact",
				url: "https://example.test/artifact",
			},
		],
		events: [
			{ type: "sandbox_codex_runner.pull_request_ready" },
			{ type: "sandbox_codex_runner.pull_request_missing" },
			{ type: "sandbox_codex_runner.pull_request_failed" },
		],
	};

	const evidence = buildEvidenceSignals(detail);

	expect(evidence.pullRequestEvidence).toEqual({
		artifactCount: 1,
		branchArtifactCount: 1,
		firstPullRequestUrl: "https://github.com/acme/repo/pull/12",
		latestPullRequestUrl: "https://github.com/acme/repo/pull/12",
		pullRequestNumber: "12",
	});
	expect(evidence.handoff).toEqual({
		pullRequestEvidenceFound: true,
		pullRequestReadyEventPresent: true,
		pullRequestMissingEventPresent: true,
		pullRequestFailedEventPresent: true,
	});

	const nextActions = buildNextActionsFromEvidence({
		pullRequestEvidenceFound: evidence.handoff.pullRequestEvidenceFound,
		pullRequestMissingEventPresent:
			evidence.handoff.pullRequestMissingEventPresent,
		pullRequestFailedEventPresent:
			evidence.handoff.pullRequestFailedEventPresent,
		runnerWorkflowRunId: evidence.runnerWorkflowRunId,
	});

	expect(nextActions).toBe(
		"Inspect runner events and logs; handoff events indicate pull request creation is missing or failed.",
	);
});
