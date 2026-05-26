import type { Client } from "@libsql/client";
import {
	createDecision,
	createLink,
	createWorkerRun,
	type Decision,
} from "@/lib/state";
import { getPullRequestCheckSummary } from "@/lib/github/checks";
import type { PullRequestCheckSummary } from "@/lib/github/checks";
import { createIssueComment, fetchIssueComments } from "@/lib/github/issues";
import {
	comparePullRequestBranches,
	getPullRequest,
	type PullRequestBranchComparison,
} from "@/lib/github/pull-requests";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";
import {
	runIntegrationRepairExecutor,
	runIntegrationRepairPlanner,
	type IntegrationRepairExecutorResult,
} from "@/lib/workers/integration-repair";
import type { PostRunDecisionPolicy } from "@/lib/post-run-decision";

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

export type HumanReviewMonitoringResult = {
	decisionId: string | null;
	workerRunId: string | null;
	classification: "human_review_fresh" | "human_review_stale" | "review_blocked";
	skippedFreshDuplicate: boolean;
	checkSummary: PullRequestCheckSummary;
};

type ObservedHumanReviewActivity = {
	hasHumanActivity: boolean;
	commentCount: number;
	latestCommentAt: string | null;
};

type HumanReviewMonitoringAssessment = {
	stale: boolean;
	outcome: "human_review_fresh" | "human_review_stale" | "review_blocked";
	reason: string;
	reasonCode: string;
	signals: string[];
	shouldAttemptBaseIntegration: boolean;
	shouldComment: boolean;
	commentBody: string | null;
	nextAction: string | null;
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
		getPullRequestCheckSummary?: typeof getPullRequestCheckSummary;
	},
): Promise<PostPrCuratorResult> {
	const checkSummary = await (
		input.getPullRequestCheckSummary ?? getPullRequestCheckSummary
	)({
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

export async function runHumanReviewMonitoring(
	client: Client,
	input: {
		workItem: GitHubProjectIssueWorkItem;
		workItemId: string;
		owner: string;
		repository: string;
		pullRequestArtifact: { number: number; url: string | null };
		existingDecisions?: Decision[];
		postRunPolicy: PostRunDecisionPolicy;
		getPullRequest?: typeof getPullRequest;
		getPullRequestCheckSummary?: typeof getPullRequestCheckSummary;
		comparePullRequestBranches?: typeof comparePullRequestBranches;
		runIntegrationRepairPlanner?: typeof runIntegrationRepairPlanner;
		runIntegrationRepairExecutor?: typeof runIntegrationRepairExecutor;
		createIssueComment?: typeof createIssueComment;
		fetchIssueComments?: typeof fetchIssueComments;
	},
): Promise<HumanReviewMonitoringResult> {
	const decisions = input.existingDecisions ?? [];
	const checkSummary = await (
		input.getPullRequestCheckSummary ?? getPullRequestCheckSummary
	)({
		owner: input.owner,
		repository: input.repository,
		pullRequestNumber: input.pullRequestArtifact.number,
	});
	const previousDecision = findLatestHumanReviewDecision(
		decisions,
		input.pullRequestArtifact.number,
	);

	if (!previousDecision) {
		return {
			decisionId: null,
			workerRunId: null,
			classification: "human_review_fresh",
			skippedFreshDuplicate: false,
			checkSummary,
		};
	}

	const pullRequest = await (input.getPullRequest ?? getPullRequest)({
		owner: input.owner,
		repository: input.repository,
		pullRequestNumber: input.pullRequestArtifact.number,
	});
	if (pullRequest.state && pullRequest.state !== "open") {
		return {
			decisionId: null,
			workerRunId: null,
			classification: "human_review_fresh",
			skippedFreshDuplicate: false,
			checkSummary,
		};
	}

	const comments = await (input.fetchIssueComments ?? fetchIssueComments)({
		owner: input.owner,
		repository: input.repository,
		issueNumber: input.pullRequestArtifact.number,
	});
	const observedHumanActivity = summarizeHumanReviewActivity(
		comments,
		previousDecision.createdAt,
	);
	const branchComparison = await (
		input.comparePullRequestBranches ?? comparePullRequestBranches
	)({
		owner: input.owner,
		repository: input.repository,
		base: pullRequest.baseRef,
		head: pullRequest.headRef,
	});

	const assessment = assessHumanReviewFreshness({
		decision: previousDecision,
		decisions,
		pullRequest,
		checkSummary,
		branchComparison,
		observedHumanActivity,
		policy: input.postRunPolicy.human_review_monitoring,
	});

	if (!assessment.stale) {
		return {
			decisionId: null,
			workerRunId: null,
			classification: "human_review_fresh",
			skippedFreshDuplicate: false,
			checkSummary,
		};
	}

	const monitoringFingerprint = buildHumanReviewMonitoringFingerprint({
		priorDecisionId: previousDecision.id,
		outcome: assessment.outcome,
		reasonCode: assessment.reasonCode,
		baseSha: pullRequest.baseSha ?? null,
		headSha: pullRequest.headSha ?? null,
		checkClassification: checkSummary.classification,
		branchStatus: branchComparison.status,
		hasHumanActivity: observedHumanActivity.hasHumanActivity,
	});
	const freshDuplicate = findFreshHumanReviewMonitoringDecision({
		decisions,
		monitoringFingerprint,
	});
	if (freshDuplicate) {
		return {
			decisionId: freshDuplicate.id,
			workerRunId: null,
			classification:
				freshDuplicate.outcome === "review_blocked"
					? "review_blocked"
					: "human_review_stale",
			skippedFreshDuplicate: true,
			checkSummary,
		};
	}

	let integrationResult: IntegrationRepairExecutorResult | null = null;
	if (assessment.shouldAttemptBaseIntegration) {
		integrationResult = await maybeRunIntegrationRepair(client, {
			workItem: input.workItem,
			workItemId: input.workItemId,
			owner: input.owner,
			repository: input.repository,
			pullRequestArtifact: input.pullRequestArtifact,
			existingDecisions: decisions,
			postPrDecisionId: previousDecision.id,
			pullRequest,
			branchComparison,
			runIntegrationRepairPlanner: input.runIntegrationRepairPlanner,
			runIntegrationRepairExecutor: input.runIntegrationRepairExecutor,
		});
	}
	const finalAssessment = applyIntegrationOutcomeToAssessment(
		assessment,
		integrationResult,
		input.postRunPolicy.human_review_monitoring.comment_on_conflict,
	);

	const workerRun = await createWorkerRun(client, {
		workItemId: input.workItemId,
		kind: "post_pr_curator",
		status: "completed",
		metadata: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestArtifact.number,
			pullRequestUrl: input.pullRequestArtifact.url ?? null,
			monitoring: true,
		},
	});
	const decisionId = await createDecision(client, {
		workItemId: input.workItemId,
		workerRunId: workerRun.id,
		phase: "post_pr",
		outcome: finalAssessment.outcome,
		deterministic: true,
		nextWorkerKind: null,
		nextAction: finalAssessment.nextAction,
		evidence: {
			monitoringFingerprint,
			priorDecisionId: previousDecision.id,
			pullRequestNumber: input.pullRequestArtifact.number,
			pullRequestUrl: input.pullRequestArtifact.url,
			baseSha: pullRequest.baseSha ?? null,
			headSha: pullRequest.headSha ?? null,
			mergeability: {
				mergeable: pullRequest.mergeable ?? null,
				mergeableState: pullRequest.mergeableState ?? null,
				branchComparison,
				checkSummary,
			},
			observedHumanActivity,
			staleReason: finalAssessment.reason,
			reasonCode: finalAssessment.reasonCode,
			staleSignals: finalAssessment.signals,
			autoIntegration: integrationResult
				? {
						attempted: true,
						outcome: integrationResult.outcome,
						decisionId: integrationResult.decisionId ?? null,
						reason: integrationResult.reason ?? null,
						terminalOutcome: integrationResult.terminalOutcome ?? null,
					}
				: { attempted: false },
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
			monitoring: true,
			outcome: finalAssessment.outcome,
			priorDecisionId: previousDecision.id,
		},
	});
	await createLink(client, {
		workItemId: input.workItemId,
		fromNodeType: "decision",
		fromNodeId: previousDecision.id,
		toNodeType: "decision",
		toNodeId: decisionId,
		relation: "observes",
		metadata: {
			outcome: finalAssessment.outcome,
			reasonCode: finalAssessment.reasonCode,
		},
	});

	if (finalAssessment.shouldComment && finalAssessment.commentBody) {
		await maybeCommentOnBlockedReview({
			comments,
			commentBody: finalAssessment.commentBody,
			commenter: input.createIssueComment ?? createIssueComment,
			owner: input.owner,
			repository: input.repository,
			pullRequestNumber: input.pullRequestArtifact.number,
		});
	}

	return {
		decisionId,
		workerRunId: workerRun.id,
		classification: finalAssessment.outcome,
		skippedFreshDuplicate: false,
		checkSummary,
	};
}

async function maybeRunIntegrationRepair(
	client: Client,
	input: {
		workItem: GitHubProjectIssueWorkItem;
		workItemId: string;
		owner: string;
		repository: string;
		pullRequestArtifact: { number: number; url: string | null };
		existingDecisions: Decision[];
		postPrDecisionId: string;
		pullRequest: Awaited<ReturnType<typeof getPullRequest>>;
		branchComparison: Awaited<ReturnType<typeof comparePullRequestBranches>>;
		runIntegrationRepairPlanner?: typeof runIntegrationRepairPlanner;
		runIntegrationRepairExecutor?: typeof runIntegrationRepairExecutor;
	},
): Promise<IntegrationRepairExecutorResult | null> {
	const plan = await (
		input.runIntegrationRepairPlanner ?? runIntegrationRepairPlanner
	)(client, {
		workItem: input.workItem,
		workItemId: input.workItemId,
		postPrDecisionId: input.postPrDecisionId,
		pullRequestNumber: input.pullRequestArtifact.number,
		pullRequestUrl: input.pullRequestArtifact.url ?? "",
		headSha: input.pullRequest.headSha ?? null,
		baseSha: input.pullRequest.baseSha ?? null,
		branchComparison: input.branchComparison,
		existingDecisions: input.existingDecisions,
	});

	if (plan.outcome !== "integration_repair_needed") {
		return null;
	}

	return await (input.runIntegrationRepairExecutor ??
		runIntegrationRepairExecutor)({
		client,
		workItem: input.workItem,
		workItemId: input.workItemId,
		pullRequestNumber: input.pullRequestArtifact.number,
		pullRequestUrl: input.pullRequestArtifact.url ?? "",
		owner: input.owner,
		repository: input.repository,
		headRef: input.pullRequest.headRef,
		baseRef: input.pullRequest.baseRef,
		plan,
	});
}

async function maybeCommentOnBlockedReview(input: {
	comments: Awaited<ReturnType<typeof fetchIssueComments>>;
	commentBody: string;
	commenter: typeof createIssueComment;
	owner: string;
	repository: string;
	pullRequestNumber: number;
}) {
	if (input.comments.some((comment) => comment.body.includes(input.commentBody))) {
		return;
	}

	await input.commenter({
		owner: input.owner,
		repository: input.repository,
		issueNumber: input.pullRequestNumber,
		body: input.commentBody,
	});
}

function findLatestHumanReviewDecision(
	decisions: Decision[],
	pullRequestNumber: number,
) {
	const matches = decisions.filter((decision) => {
		if (decision.phase !== "post_pr" || decision.outcome !== "human_review") {
			return false;
		}

		const evidence = asRecord(decision.evidence);
		return evidence?.pullRequestNumber === pullRequestNumber;
	});

	return matches.sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
}

function assessHumanReviewFreshness(input: {
	decision: Decision;
	decisions: Decision[];
	pullRequest: Awaited<ReturnType<typeof getPullRequest>>;
	checkSummary: PullRequestCheckSummary;
	branchComparison: PullRequestBranchComparison;
	observedHumanActivity: ObservedHumanReviewActivity;
	policy: PostRunDecisionPolicy["human_review_monitoring"];
}): HumanReviewMonitoringAssessment {
	const priorSnapshot = extractPriorHumanReviewSnapshot(
		input.decision,
		input.decisions,
	);
	const signals: string[] = [];
	const branchIsBehind =
		input.branchComparison.status === "behind" ||
		(input.branchComparison.behindBy !== null &&
			input.branchComparison.behindBy > 0);

	if (
		(priorSnapshot.baseSha &&
			priorSnapshot.baseSha !== (input.pullRequest.baseSha ?? null)) ||
		branchIsBehind
	) {
		signals.push("base_moved");
	}
	if (
		priorSnapshot.headSha &&
		priorSnapshot.headSha !== (input.pullRequest.headSha ?? null)
	) {
		signals.push("head_changed");
	}
	if (
		priorSnapshot.checkClassification &&
		priorSnapshot.checkClassification !== input.checkSummary.classification
	) {
		signals.push("checks_invalidated");
	}
	if (
		typeof priorSnapshot.mergeable === "boolean" &&
		priorSnapshot.mergeable !== (input.pullRequest.mergeable ?? null)
	) {
		signals.push("mergeability_changed");
	}
	if (
		priorSnapshot.mergeableState &&
		priorSnapshot.mergeableState !== (input.pullRequest.mergeableState ?? null)
	) {
		signals.push("mergeability_changed");
	}

	const allowBaseIntegration = input.observedHumanActivity.hasHumanActivity
		? input.policy.auto_integrate_base_after_human_activity
		: input.policy.auto_integrate_base_before_human_activity;
	const shouldCommentOnConflict = input.policy.comment_on_conflict;
	const hasConflictSignal =
		input.pullRequest.mergeable === false ||
		input.pullRequest.mergeableState === "dirty" ||
		input.pullRequest.mergeableState === "blocked";

	if (signals.length === 0) {
		return {
			stale: false,
			outcome: "human_review_fresh",
			reason:
				"Earlier human review evidence still matches the current pull request state.",
			reasonCode: "fresh",
			signals,
			shouldAttemptBaseIntegration: false,
			shouldComment: false,
			commentBody: null,
			nextAction: null,
		};
	}
	if (branchIsBehind && !allowBaseIntegration) {
		return {
			stale: true,
			outcome: "review_blocked",
			reason: input.observedHumanActivity.hasHumanActivity
				? "Base branch moved after human review activity, so Rhapsody did not update the branch automatically."
				: "Base branch moved, but automatic base integration is disabled by policy.",
			reasonCode: input.observedHumanActivity.hasHumanActivity
				? "behind_base_after_human_activity"
				: "base_integration_disabled",
			signals,
			shouldAttemptBaseIntegration: false,
			shouldComment: shouldCommentOnConflict,
			commentBody: shouldCommentOnConflict
				? input.observedHumanActivity.hasHumanActivity
					? "Rhapsody detected new human review activity after the base branch moved, so it left this PR in Human Review instead of automatically updating the branch. Please update the branch or resolve conflicts manually, then continue review."
					: "Rhapsody detected that this PR is behind its base branch, but automatic base integration is disabled by policy. Please update the branch or resolve conflicts manually, then continue review."
				: null,
			nextAction:
				"Keep the Project item in Human Review and ask the reviewer to update the branch manually.",
		};
	}

	if (hasConflictSignal && !branchIsBehind) {
		return {
			stale: true,
			outcome: "review_blocked",
			reason:
				"GitHub no longer reports the pull request as cleanly mergeable, so human intervention is required.",
			reasonCode: "mergeability_conflict",
			signals: [...signals, "mergeability_conflict"],
			shouldAttemptBaseIntegration: false,
			shouldComment: shouldCommentOnConflict,
			commentBody: shouldCommentOnConflict
				? "Rhapsody detected that this PR is no longer cleanly mergeable. The Project item remains in Human Review. Please resolve the merge conflict or update the branch manually, then continue review."
				: null,
			nextAction:
				"Keep the Project item in Human Review and ask the reviewer to resolve the mergeability conflict manually.",
		};
	}

	return {
		stale: true,
		outcome: "human_review_stale",
		reason:
			"Earlier human review evidence no longer matches the current pull request state.",
		reasonCode: branchIsBehind ? "base_moved" : signals[0] ?? "human_review_stale",
		signals,
		shouldAttemptBaseIntegration: branchIsBehind && allowBaseIntegration,
		shouldComment: false,
		commentBody: null,
		nextAction: branchIsBehind && allowBaseIntegration
			? "Attempt non-rewriting base integration before asking for more human review."
			: "Keep the Project item in Human Review and surface the stale review state to the reviewer.",
	};
}

function applyIntegrationOutcomeToAssessment(
	assessment: HumanReviewMonitoringAssessment,
	integrationResult: IntegrationRepairExecutorResult | null,
	commentOnConflict: boolean,
): HumanReviewMonitoringAssessment {
	if (!integrationResult) {
		return assessment;
	}

	const successLike =
		integrationResult.outcome === "integration_repair_applied" ||
		integrationResult.outcome === "integration_repair_conflict_resolved" ||
		integrationResult.outcome === "integration_repair_skipped_in_progress" ||
		(integrationResult.outcome === "integration_repair_skipped_terminal" &&
			(integrationResult.terminalOutcome === "integration_repair_applied" ||
				integrationResult.terminalOutcome ===
					"integration_repair_conflict_resolved"));
	if (successLike) {
		return {
			...assessment,
			outcome: "human_review_stale",
			reason:
				"Base branch moved and Rhapsody started or completed a non-rewriting base integration before human review resumed.",
			reasonCode: "base_moved",
			nextAction:
				"Keep the Project item in Human Review while the updated pull request head is re-observed.",
		};
	}

	const blockedLike =
		integrationResult.outcome === "integration_repair_conflict_unresolved" ||
		integrationResult.outcome === "integration_repair_failed" ||
		(integrationResult.outcome === "integration_repair_skipped_terminal" &&
			(integrationResult.terminalOutcome ===
				"integration_repair_conflict_unresolved" ||
				integrationResult.terminalOutcome === "integration_repair_failed"));
	if (blockedLike) {
		return {
			...assessment,
			outcome: "review_blocked",
			reason:
				integrationResult.reason ??
				"Rhapsody could not safely integrate the latest base branch before human review.",
			reasonCode: "base_integration_conflict",
			shouldComment: commentOnConflict,
			commentBody: commentOnConflict
				? "Rhapsody tried a non-rewriting base integration before human review, but it could not complete safely. The Project item remains in Human Review. Please update the branch or resolve the conflict manually, then continue review."
				: null,
			nextAction:
				"Keep the Project item in Human Review and ask the reviewer to update the branch or resolve conflicts manually.",
		};
	}

	return assessment;
}

function extractPriorHumanReviewSnapshot(decision: Decision, decisions: Decision[]) {
	const evidence = asRecord(decision.evidence);
	const sourceDecisionId =
		typeof evidence?.sourceDecisionId === "string" ? evidence.sourceDecisionId : null;
	const sourceDecision =
		sourceDecisionId === null
			? null
			: (decisions.find((candidate) => candidate.id === sourceDecisionId) ?? null);
	const sourceEvidence = asRecord(sourceDecision?.evidence);
	const sourceChecks = asRecord(sourceEvidence?.checks);
	const directCheckSummary = asRecord(evidence?.checkSummary);
	const directMergeability = asRecord(evidence?.mergeability);
	const sourceMergeability = asRecord(sourceEvidence?.mergeability);

	return {
		baseSha:
			typeof evidence?.baseSha === "string" ? evidence.baseSha : null,
		headSha:
			typeof evidence?.headSha === "string"
				? evidence.headSha
				: typeof directCheckSummary?.headSha === "string"
					? directCheckSummary.headSha
					: typeof sourceChecks?.headSha === "string"
						? sourceChecks.headSha
						: null,
		checkClassification:
			typeof evidence?.checkClassification === "string"
				? evidence.checkClassification
				: typeof directCheckSummary?.classification === "string"
					? directCheckSummary.classification
					: typeof sourceChecks?.classification === "string"
						? sourceChecks.classification
						: null,
		mergeable:
			typeof directMergeability?.mergeable === "boolean"
				? directMergeability.mergeable
				: typeof sourceMergeability?.mergeable === "boolean"
					? sourceMergeability.mergeable
					: null,
		mergeableState:
			typeof directMergeability?.mergeableState === "string"
				? directMergeability.mergeableState
				: typeof sourceMergeability?.mergeableState === "string"
					? sourceMergeability.mergeableState
					: null,
	};
}

function buildHumanReviewMonitoringFingerprint(input: {
	priorDecisionId: string;
	outcome: "human_review_stale" | "review_blocked";
	reasonCode: string;
	baseSha: string | null;
	headSha: string | null;
	checkClassification: PullRequestCheckSummary["classification"];
	branchStatus: PullRequestBranchComparison["status"];
	hasHumanActivity: boolean;
}) {
	return [
		input.priorDecisionId,
		input.outcome,
		input.reasonCode,
		input.baseSha ?? "unknown-base",
		input.headSha ?? "unknown-head",
		input.checkClassification,
		input.branchStatus,
		input.hasHumanActivity ? "human" : "no-human",
	].join(":");
}

function findFreshHumanReviewMonitoringDecision(input: {
	decisions: Decision[];
	monitoringFingerprint: string;
}) {
	const matches = input.decisions.filter((decision) => {
		if (
			decision.phase !== "post_pr" ||
			(decision.outcome !== "human_review_stale" &&
				decision.outcome !== "review_blocked")
		) {
			return false;
		}

		const evidence = asRecord(decision.evidence);
		return evidence?.monitoringFingerprint === input.monitoringFingerprint;
	});

	return matches.sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
}

function summarizeHumanReviewActivity(
	comments: Awaited<ReturnType<typeof fetchIssueComments>>,
	sinceTimestamp: number,
): ObservedHumanReviewActivity {
	const humanComments = comments.filter((comment) => {
		const updatedAt = Date.parse(comment.updatedAt);
		const author = comment.authorLogin?.toLowerCase() ?? "";

		return (
			Boolean(author) &&
			!author.endsWith("[bot]") &&
			author !== "github-actions" &&
			Number.isFinite(updatedAt) &&
			updatedAt > sinceTimestamp
		);
	});

	return {
		hasHumanActivity: humanComments.length > 0,
		commentCount: humanComments.length,
		latestCommentAt:
			humanComments
				.map((comment) => comment.updatedAt)
				.sort()
				.at(-1) ?? null,
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
