import { expect, test } from "vitest";
import {
	buildEvidenceSignals,
	buildFetchFailureNextActions,
	buildInvalidArgsReport,
	buildNextActionsFromEvidence,
	evaluateWaitDecision,
	parseArgs,
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
		firstBranchUrl: "https://github.com/acme/repo/tree/feature-run",
		latestBranchUrl: "https://github.com/acme/repo/tree/feature-run",
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
		branchArtifactCount: 1,
		latestBranchUrl: evidence.pullRequestEvidence.latestBranchUrl,
		runnerWorkflowRunId: evidence.runnerWorkflowRunId,
	});

	expect(nextActions).toBe(
		"Inspect runner events and logs; handoff events indicate pull request creation is missing or failed. Branch artifact(s) were observed; inspect https://github.com/acme/repo/tree/feature-run before retrying PR handoff.",
	);
});

test("builds concrete verify-run fetch failure next actions", () => {
	expect(
		buildFetchFailureNextActions({
			classification: "network-error",
			status: null,
		}),
	).toEqual([
		"Confirm the preview URL is the deployed Rhapsody app, then inspect the Vercel deployment logs before rerunning verify-run.",
	]);

	expect(
		buildFetchFailureNextActions({
			classification: "unauthorized",
			status: 401,
		}),
	).toEqual([
		"Confirm ROOT_PASSWORD matches the preview deployment, then rerun verify-run with --use-root-password.",
	]);

	expect(
		buildFetchFailureNextActions({
			classification: "not-found",
			status: 404,
		}),
	).toEqual([
		"Confirm the run ID from setup:first-issue or the dashboard, then rerun verify-run with the corrected --run-id.",
	]);
});

test("does not treat missing or failed PR events as successful PR evidence", () => {
	const missingOnly = buildEvidenceSignals({
		events: [{ type: "sandbox_codex_runner.pull_request_missing" }],
	});

	expect(missingOnly.handoff).toEqual({
		pullRequestEvidenceFound: false,
		pullRequestReadyEventPresent: false,
		pullRequestMissingEventPresent: true,
		pullRequestFailedEventPresent: false,
	});

	const failedOnly = buildEvidenceSignals({
		events: [{ type: "sandbox_codex_runner.pull_request_failed" }],
	});

	expect(failedOnly.handoff).toEqual({
		pullRequestEvidenceFound: false,
		pullRequestReadyEventPresent: false,
		pullRequestMissingEventPresent: false,
		pullRequestFailedEventPresent: true,
	});
});

test("parses verify-run args with default values", () => {
	const result = parseArgs([
		"node",
		"scripts/setup-rhapsody-verify-run.ts",
		"--url",
		"https://example.test",
		"--run-id",
		"run_abc",
	]);

	expect(result).toEqual({
		ok: true,
		url: "https://example.test",
		runId: "run_abc",
		useRootPassword: false,
		wait: false,
		timeoutMs: 300_000,
		intervalMs: 10_000,
	});
});

test("requires --use-root-password for wait mode", () => {
	const result = parseArgs([
		"node",
		"scripts/setup-rhapsody-verify-run.ts",
		"--url",
		"https://example.test",
		"--run-id",
		"run_abc",
		"--wait",
	]);

	expect(result).toEqual({
		ok: false,
		error: "--wait requires --use-root-password.",
	});
});

test("enforces wait argument constraints", () => {
	const missingRequiredRunAuth = parseArgs([
		"node",
		"scripts/setup-rhapsody-verify-run.ts",
		"--url",
		"https://example.test",
		"--wait",
		"--use-root-password",
		"--interval-ms",
		"abc",
		"--run-id",
		"run_abc",
	]);

	expect(missingRequiredRunAuth).toEqual({
		ok: false,
		error: "--interval-ms must be a positive integer.",
	});

	const invalidCombination = parseArgs([
		"node",
		"scripts/setup-rhapsody-verify-run.ts",
		"--url",
		"https://example.test",
		"--run-id",
		"run_abc",
		"--interval-ms",
		"1000",
	]);

	expect(invalidCombination).toEqual({
		ok: false,
		error: "`--timeout-ms` and `--interval-ms` require `--wait` to be enabled.",
	});
});

test("keeps provided input facts in invalid argument reports", () => {
	const report = buildInvalidArgsReport(
		"--interval-ms must be less than --timeout-ms.",
		[
			"node",
			"scripts/setup-rhapsody-verify-run.ts",
			"--url",
			"https://example.test",
			"--run-id",
			"run_abc",
			"--use-root-password",
			"--wait",
			"--timeout-ms",
			"1000",
			"--interval-ms",
			"1000",
		],
	);

	expect(report.facts.input).toEqual({
		providedUrl: "https://example.test",
		normalizedBaseUrl: "https://example.test",
		runId: "run_abc",
		useRootPasswordRequested: true,
	});
	expect(report.facts.request).toEqual({
		endpoint: "https://example.test/api/v1/runs/run_abc",
		method: "GET",
		auth: "bearer",
	});
	expect(report.needsUser).toEqual([]);
	expect(report.nextActions).toEqual([
		"Rerun with --timeout-ms greater than --interval-ms, for example --timeout-ms 300000 --interval-ms 10000.",
	]);
});

test("evaluateWaitDecision chooses terminal outcomes", () => {
	const evidence1 = evaluateWaitDecision({
		pullRequestEvidenceFound: false,
		pullRequestMissingEventPresent: true,
		pullRequestFailedEventPresent: false,
	});
	expect(evidence1).toEqual({ kind: "pull-request-missing", terminal: true });

	const evidence2 = evaluateWaitDecision({
		pullRequestEvidenceFound: true,
		pullRequestMissingEventPresent: false,
		pullRequestFailedEventPresent: false,
	});
	expect(evidence2).toEqual({
		kind: "handoff-evidence-found",
		terminal: true,
	});

	const evidence3 = evaluateWaitDecision({
		pullRequestEvidenceFound: false,
		pullRequestMissingEventPresent: false,
		pullRequestFailedEventPresent: false,
	});
	expect(evidence3).toEqual({ kind: "continue", terminal: false });
});
