import type { Client } from "@libsql/client";
import {
	createDecision,
	createLink,
	createWorkerRun,
	updateWorkerRunStatus,
	type Decision,
} from "@/lib/state";
import type {
	PullRequestCheckRunSummary,
	PullRequestCheckSummary,
} from "@/lib/github/checks";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";

const MAX_FORMAT_REPAIR_ATTEMPTS = 2;

export type RepairerClassification =
	| "format_fixable"
	| "not_deterministically_fixable";

export type RepairerDecisionOutcome = "repair_allowed" | "repair_blocked";

export type RepairerResult = {
	workerRunId: string;
	decisionId: string;
	outcome: RepairerDecisionOutcome;
	classification: RepairerClassification;
	attemptCount: number;
};

export async function runRepairerPlanner(
	client: Client,
	input: {
		workItem: GitHubProjectIssueWorkItem;
		workItemId: string;
		postPrDecisionId: string;
		pullRequestNumber: number;
		pullRequestUrl: string;
		checkSummary: PullRequestCheckSummary;
		existingDecisions: Decision[];
	},
): Promise<RepairerResult> {
	const classification = classifyRepair(input.checkSummary);
	const attemptCount = countPriorFormatRepairAttempts({
		decisions: input.existingDecisions,
		pullRequestNumber: input.pullRequestNumber,
		headSha: input.checkSummary.headSha,
	});
	const allowed =
		classification === "format_fixable" &&
		attemptCount < MAX_FORMAT_REPAIR_ATTEMPTS;
	const outcome: RepairerDecisionOutcome = allowed
		? "repair_allowed"
		: "repair_blocked";
	const workerRun = await createWorkerRun(client, {
		workItemId: input.workItemId,
		kind: "repairer",
		status: "completed",
		metadata: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestNumber,
			classification,
			attemptCount,
			maxAttempts: MAX_FORMAT_REPAIR_ATTEMPTS,
		},
	});
	const decisionId = await createDecision(client, {
		workItemId: input.workItemId,
		workerRunId: workerRun.id,
		phase: "repair",
		outcome,
		deterministic: true,
		policyRuleId: classification,
		nextWorkerKind: allowed ? "repairer" : null,
		nextAction: allowed
			? "Run a narrow format repair on the pull request branch."
			: "Escalate because the failure is not safely repairable or repair budget is exhausted.",
		evidence: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestNumber,
			pullRequestUrl: input.pullRequestUrl,
			classification,
			attemptCount,
			maxAttempts: MAX_FORMAT_REPAIR_ATTEMPTS,
			checks: input.checkSummary,
		},
	});

	await Promise.all([
		createLink(client, {
			workItemId: input.workItemId,
			fromNodeType: "decision",
			fromNodeId: input.postPrDecisionId,
			toNodeType: "worker_run",
			toNodeId: workerRun.id,
			relation: "starts",
			metadata: {
				reason: classification,
			},
		}),
		createLink(client, {
			workItemId: input.workItemId,
			fromNodeType: "worker_run",
			fromNodeId: workerRun.id,
			toNodeType: "decision",
			toNodeId: decisionId,
			relation: "decides",
			metadata: {
				outcome,
			},
		}),
		updateWorkerRunStatus(client, {
			id: workerRun.id,
			status: "completed",
		}),
	]);

	return {
		workerRunId: workerRun.id,
		decisionId,
		outcome,
		classification,
		attemptCount,
	};
}

export function classifyRepair(
	checkSummary: PullRequestCheckSummary,
): RepairerClassification {
	if (checkSummary.classification !== "ci_failed") {
		return "not_deterministically_fixable";
	}

	const failedRuns = checkSummary.checkRuns.filter(isFailedCheckRun);
	if (failedRuns.length === 0) {
		return "not_deterministically_fixable";
	}

	if (failedRuns.every(isFormatCheckRun)) {
		return "format_fixable";
	}

	return "not_deterministically_fixable";
}

function countPriorFormatRepairAttempts(input: {
	decisions: Decision[];
	pullRequestNumber: number;
	headSha: string | null;
}) {
	return input.decisions.filter((decision) => {
		if (decision.phase !== "repair") {
			return false;
		}

		const evidence = asRecord(decision.evidence);
		const checks = asRecord(evidence?.checks);

		return (
			evidence?.pullRequestNumber === input.pullRequestNumber &&
			evidence?.classification === "format_fixable" &&
			checks?.headSha === input.headSha
		);
	}).length;
}

function isFailedCheckRun(checkRun: PullRequestCheckRunSummary) {
	return (
		checkRun.status === "completed" &&
		checkRun.conclusion !== null &&
		["failure", "error", "timed_out", "cancelled", "action_required"].includes(
			checkRun.conclusion,
		)
	);
}

function isFormatCheckRun(checkRun: PullRequestCheckRunSummary) {
	const name = checkRun.name.toLowerCase();
	return (
		name.includes("format") ||
		name.includes("biome") ||
		name.includes("prettier")
	);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}
