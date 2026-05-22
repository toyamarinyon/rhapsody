import type { Client } from "@libsql/client";
import {
	createDecision,
	createLink,
	createWorkerRun,
	type Decision,
} from "@/lib/state";
import { getPullRequestCheckSummary } from "@/lib/github/checks";
import type { PullRequestCheckSummary } from "@/lib/github/checks";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";

export type PostPrCuratorResult = {
	decisionId: string;
	workerRunId: string | null;
	classification:
		| "checks_pending"
		| "checks_success"
		| "ci_failed"
		| "checks_unknown";
	skippedFreshDuplicate: boolean;
	checkSummary: PullRequestCheckSummary;
};

export async function runPostPrCurator(
	client: Client,
	input: {
		workItem: GitHubProjectIssueWorkItem;
		workItemId: string;
		owner: string;
		repository: string;
		pullRequestNumber: number;
		pullRequestUrl: string;
		existingDecisions?: Decision[];
	},
): Promise<PostPrCuratorResult> {
	const checkSummary = await getPullRequestCheckSummary({
		owner: input.owner,
		repository: input.repository,
		pullRequestNumber: input.pullRequestNumber,
	});
	const freshDecision = findFreshPostPrDecision({
		decisions: input.existingDecisions ?? [],
		pullRequestNumber: input.pullRequestNumber,
		classification: checkSummary.classification,
		headSha: checkSummary.headSha,
	});

	if (freshDecision) {
		return {
			decisionId: freshDecision.id,
			workerRunId: null,
			classification: checkSummary.classification,
			skippedFreshDuplicate: true,
			checkSummary,
		};
	}

	const workerRun = await createWorkerRun(client, {
		workItemId: input.workItemId,
		kind: "post_pr_curator",
		status: "completed",
		metadata: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestNumber,
			pullRequestUrl: input.pullRequestUrl,
		},
	});

	const decisionId = await createDecision(client, {
		workItemId: input.workItemId,
		workerRunId: workerRun.id,
		phase: "post_pr",
		outcome: checkSummary.classification,
		deterministic: true,
		nextWorkerKind: null,
		evidence: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestNumber,
			pullRequestUrl: input.pullRequestUrl,
			checks: checkSummary,
		},
	});

	await createLink(client, {
		workItemId: input.workItemId,
		fromNodeType: "worker_run",
		fromNodeId: workerRun.id,
		toNodeType: "decision",
		toNodeId: decisionId,
		relation: "evaluates",
		metadata: {
			checkClassification: checkSummary.classification,
		},
	});

	return {
		decisionId,
		workerRunId: workerRun.id,
		classification: checkSummary.classification,
		skippedFreshDuplicate: false,
		checkSummary,
	};
}

function findFreshPostPrDecision(input: {
	decisions: Decision[];
	pullRequestNumber: number;
	classification: string;
	headSha: string | null;
}): Decision | null {
	return (
		input.decisions.find((decision) => {
			if (
				decision.phase !== "post_pr" ||
				decision.outcome !== input.classification
			) {
				return false;
			}

			const evidence = asRecord(decision.evidence);
			const checks = asRecord(evidence?.checks);

			return (
				evidence?.pullRequestNumber === input.pullRequestNumber &&
				checks?.headSha === input.headSha &&
				checks?.classification === input.classification
			);
		}) ?? null
	);
}

export function findPullRequestArtifactFromArtifacts(
	artifacts: {
		id: string;
		kind: string;
		externalId: string | null;
		externalUrl: string | null;
		createdAt: number;
	}[],
): { id: string; number: number; url: string | null } | null {
	const candidate = artifacts.find(
		(candidateArtifact) =>
			candidateArtifact.kind === "pull_request" && candidateArtifact.externalId,
	);

	if (!candidate || !candidate.externalId) {
		return null;
	}

	const number = Number.parseInt(candidate.externalId, 10);
	if (!Number.isFinite(number) || number <= 0) {
		return null;
	}

	return {
		id: candidate.id,
		number,
		url: candidate.externalUrl,
	};
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}
