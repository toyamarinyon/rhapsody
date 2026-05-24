import type { Client } from "@libsql/client";
import type {
	PullRequestCheckRunSummary,
	PullRequestCheckSummary,
} from "@/lib/github/checks";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";
import {
	loadRepairConfig,
	type RepairConfig,
	type RepairFormatCheckRule,
} from "@/lib/repair-config";
import {
	createDecision,
	createLink,
	createWorkerRun,
	type Decision,
	updateWorkerRunStatus,
} from "@/lib/state";

export const MAX_FORMAT_REPAIR_ATTEMPTS_PER_HEAD_SHA = 2;
export const MAX_FORMAT_REPAIR_ATTEMPTS_PER_PULL_REQUEST = 6;
export const MAX_FORMAT_REPAIR_ATTEMPTS_PER_FAILURE_FINGERPRINT = 2;

export type RepairerClassification =
	| "format_fixable"
	| "not_deterministically_fixable";

export type RepairerDecisionOutcome = "repair_allowed" | "repair_blocked";

export type RepairerAttemptOutcome =
	| "repair_allowed"
	| "repair_applied"
	| "repair_noop"
	| "repair_failed";

export type RepairerAttemptCounts = {
	headSha: number;
	pullRequest: number;
	fingerprint: number;
};

export type RepairerAttemptBudgets = {
	headSha: number;
	pullRequest: number;
	fingerprint: number;
};

export type RepairerPlannerResult = {
	workerRunId: string;
	decisionId: string;
	outcome: RepairerDecisionOutcome;
	classification: RepairerClassification;
	attemptCount: number;
	attemptCounts: RepairerAttemptCounts;
	maxAttempts: RepairerAttemptBudgets;
	repairExecutionKey: string;
	failureFingerprint: string;
};

const EMPTY_REPAIR_CONFIG: RepairConfig = {
	repair: {
		format_checks: [],
	},
};

export type RepairerExecutionKeyInput = {
	pullRequestNumber: number;
	headSha: string | null;
	failureFingerprint: string;
};

export function buildRepairExecutionKey(input: RepairerExecutionKeyInput) {
	const headKey = input.headSha ?? "unknown";
	return `${input.pullRequestNumber}:${headKey}:${input.failureFingerprint}`;
}

export function buildFailureFingerprint(
	checkSummary: Pick<PullRequestCheckSummary, "checkRuns">,
): string {
	const failures = checkSummary.checkRuns
		.filter(isFailedCheckRun)
		.map((checkRun) => {
			return [
				normalizeCheckName(checkRun.name),
				normalizeStatus(checkRun.status),
				normalizeConclusion(checkRun.conclusion),
				normalizeWorkflowPathForFingerprint(checkRun.actions?.workflowPath),
				normalizeCheckName(checkRun.actions?.jobName ?? ""),
				normalizeStepNamesForFingerprint(
					checkRun.actions?.failedStepNames ?? [],
				),
			].join("::");
		})
		.sort();

	if (failures.length === 0) {
		return "no_failed_checks";
	}

	return failures.join("|");
}

function normalizeCheckName(value: string) {
	return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeStatus(value: string) {
	return (value ?? "").trim().toLowerCase();
}

function normalizeConclusion(value: string | null) {
	return (value ?? "").trim().toLowerCase();
}

function normalizeWorkflowPathForFingerprint(value: string | null | undefined) {
	return normalizeWorkflowPath(value);
}

function normalizeStepNamesForFingerprint(stepNames: string[]) {
	return [...stepNames]
		.map((stepName) => normalizeCheckName(stepName))
		.filter((stepName) => stepName.length > 0)
		.sort()
		.join(",");
}

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
		repairConfig?: RepairConfig;
	},
): Promise<RepairerPlannerResult> {
	const repairConfig = input.repairConfig ?? (await loadRepairConfig()).config;
	const classification = classifyRepair(input.checkSummary, repairConfig);
	const failureFingerprint = buildFailureFingerprint(input.checkSummary);
	const repairExecutionKey = buildRepairExecutionKey({
		pullRequestNumber: input.pullRequestNumber,
		headSha: input.checkSummary.headSha,
		failureFingerprint,
	});
	const attemptCounts = countPriorFormatRepairAttempts({
		decisions: input.existingDecisions,
		pullRequestNumber: input.pullRequestNumber,
		headSha: input.checkSummary.headSha,
		failureFingerprint,
	});
	const maxAttempts = {
		headSha: MAX_FORMAT_REPAIR_ATTEMPTS_PER_HEAD_SHA,
		pullRequest: MAX_FORMAT_REPAIR_ATTEMPTS_PER_PULL_REQUEST,
		fingerprint: MAX_FORMAT_REPAIR_ATTEMPTS_PER_FAILURE_FINGERPRINT,
	};
	const allowed =
		classification === "format_fixable" &&
		attemptCounts.headSha < maxAttempts.headSha &&
		attemptCounts.pullRequest < maxAttempts.pullRequest &&
		attemptCounts.fingerprint < maxAttempts.fingerprint;
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
			pullRequestUrl: input.pullRequestUrl,
			classification,
			attemptCounts,
			maxAttempts,
			repairExecutionKey,
			failureFingerprint,
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
			? `Run a narrow format repair for execution key ${repairExecutionKey}.`
			: "Escalate because the failure is not safely repairable or repair budget is exhausted.",
		evidence: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestNumber,
			pullRequestUrl: input.pullRequestUrl,
			classification,
			attemptCount: attemptCounts.headSha,
			attemptCounts,
			maxAttempts,
			repairExecutionKey,
			failureFingerprint,
			checks: {
				headSha: input.checkSummary.headSha,
			},
			checkSummary: input.checkSummary,
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
				repairExecutionKey,
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
				repairExecutionKey,
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
		attemptCount: attemptCounts.headSha,
		attemptCounts,
		maxAttempts,
		repairExecutionKey,
		failureFingerprint,
	};
}

export function classifyRepair(
	checkSummary: PullRequestCheckSummary,
	repairConfig: RepairConfig = EMPTY_REPAIR_CONFIG,
): RepairerClassification {
	if (checkSummary.classification !== "ci_failed") {
		return "not_deterministically_fixable";
	}

	const failedRuns = checkSummary.checkRuns.filter(isFailedCheckRun);
	if (failedRuns.length === 0) {
		return "not_deterministically_fixable";
	}

	if (
		failedRuns.every((checkRun) => isFormatCheckRun(checkRun, repairConfig))
	) {
		return "format_fixable";
	}

	return "not_deterministically_fixable";
}

export function countPriorFormatRepairAttempts(input: {
	decisions: Decision[];
	pullRequestNumber: number;
	headSha: string | null;
	failureFingerprint: string;
}): RepairerAttemptCounts {
	const relevant = input.decisions.filter((decision) => {
		if (decision.phase !== "repair") {
			return false;
		}

		if (!isRepairAttemptOutcome(decision.outcome)) {
			return false;
		}

		const evidence = asRepairDecisionRecord(decision.evidence);

		if (
			evidence?.pullRequestNumber !== input.pullRequestNumber ||
			evidence?.classification !== "format_fixable"
		) {
			return false;
		}

		return true;
	});

	return relevant.reduce(
		(total, decision) => {
			const evidence = asRepairDecisionRecord(decision.evidence);
			const checks = asRecord(evidence?.checks);
			const thisHeadSha =
				typeof checks?.headSha === "string" ? checks.headSha : null;
			const thisFailureFingerprint =
				typeof evidence?.failureFingerprint === "string"
					? evidence.failureFingerprint
					: null;

			return {
				headSha: total.headSha + (thisHeadSha === input.headSha ? 1 : 0),
				pullRequest: total.pullRequest + 1,
				fingerprint:
					total.fingerprint +
					(thisFailureFingerprint === input.failureFingerprint ? 1 : 0),
			};
		},
		{ headSha: 0, pullRequest: 0, fingerprint: 0 },
	);
}

export function hasTerminalRepairDecisionOutcome(decision: Decision): boolean {
	return (
		decision.phase === "repair" &&
		(decision.outcome === "repair_applied" ||
			decision.outcome === "repair_noop")
	);
}

export function buildRepairPlanFromRepairDecision(decision: Decision): {
	decisionId: string;
	repairExecutionKey: string;
	failureFingerprint: string;
	attemptCounts: RepairerAttemptCounts;
	maxAttempts: RepairerAttemptBudgets;
} | null {
	const evidence = asRepairDecisionRecord(decision.evidence);
	if (decision.phase !== "repair" || decision.outcome !== "repair_allowed") {
		return null;
	}

	if (
		typeof evidence?.repairExecutionKey !== "string" ||
		typeof evidence?.failureFingerprint !== "string"
	) {
		return null;
	}

	const attemptCounts = isRepairAttemptCounts(evidence.attemptCounts)
		? evidence.attemptCounts
		: null;
	const maxAttempts = isRepairAttemptBudgets(evidence.maxAttempts)
		? evidence.maxAttempts
		: {
				headSha: MAX_FORMAT_REPAIR_ATTEMPTS_PER_HEAD_SHA,
				pullRequest: MAX_FORMAT_REPAIR_ATTEMPTS_PER_PULL_REQUEST,
				fingerprint: MAX_FORMAT_REPAIR_ATTEMPTS_PER_FAILURE_FINGERPRINT,
			};

	if (!attemptCounts) {
		return null;
	}

	return {
		decisionId: decision.id,
		repairExecutionKey: evidence.repairExecutionKey,
		failureFingerprint: evidence.failureFingerprint,
		attemptCounts,
		maxAttempts,
	};
}

export function asRepairDecisionRecord(
	value: unknown,
): Record<string, unknown> | null {
	return asRecord(value);
}

function isRepairAttemptOutcome(
	outcome: string,
): outcome is RepairerAttemptOutcome {
	return (
		outcome === "repair_allowed" ||
		outcome === "repair_applied" ||
		outcome === "repair_noop" ||
		outcome === "repair_failed"
	);
}

function isRepairAttemptCounts(value: unknown): value is RepairerAttemptCounts {
	const record = asRecord(value);
	if (!record) {
		return false;
	}
	return (
		typeof record.headSha === "number" &&
		typeof record.pullRequest === "number" &&
		typeof record.fingerprint === "number"
	);
}

function isRepairAttemptBudgets(
	value: unknown,
): value is RepairerAttemptBudgets {
	const record = asRecord(value);
	if (!record) {
		return false;
	}
	return (
		typeof record.headSha === "number" &&
		typeof record.pullRequest === "number" &&
		typeof record.fingerprint === "number"
	);
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

function isFormatCheckRun(
	checkRun: PullRequestCheckRunSummary,
	repairConfig: RepairConfig,
) {
	if (matchesConfiguredFormatCheck(checkRun, repairConfig)) {
		return true;
	}

	if (hasUsableActionsMetadata(checkRun, repairConfig)) {
		return false;
	}

	const name = checkRun.name.toLowerCase();
	return (
		name.includes("format") ||
		name.includes("biome") ||
		name.includes("prettier")
	);
}

function matchesConfiguredFormatCheck(
	checkRun: PullRequestCheckRunSummary,
	repairConfig: RepairConfig,
) {
	const formatCheckRules = repairConfig.repair.format_checks;
	if (formatCheckRules.length === 0) {
		return false;
	}

	const workflowPath = normalizeWorkflowPath(checkRun.actions?.workflowPath);
	const jobName = normalizeConfiguredValue(checkRun.actions?.jobName);
	const failedStepNames = (checkRun.actions?.failedStepNames ?? [])
		.map((stepName) => normalizeConfiguredValue(stepName))
		.filter((stepName) => stepName.length > 0);

	if (!workflowPath || !jobName || failedStepNames.length === 0) {
		return false;
	}

	return formatCheckRules.some((rule) =>
		matchesConfiguredFormatRule(rule, workflowPath, jobName, failedStepNames),
	);
}

function hasUsableActionsMetadata(
	checkRun: PullRequestCheckRunSummary,
	repairConfig: RepairConfig,
) {
	if (repairConfig.repair.format_checks.length === 0) {
		return false;
	}

	const workflowPath = normalizeWorkflowPath(checkRun.actions?.workflowPath);
	const jobName = normalizeConfiguredValue(checkRun.actions?.jobName);
	const failedStepNames = (checkRun.actions?.failedStepNames ?? [])
		.map((stepName) => normalizeConfiguredValue(stepName))
		.filter((stepName) => stepName.length > 0);

	return Boolean(workflowPath && jobName && failedStepNames.length > 0);
}

function matchesConfiguredFormatRule(
	rule: RepairFormatCheckRule,
	workflowPath: string,
	jobName: string,
	failedStepNames: string[],
) {
	return (
		normalizeWorkflowPath(rule.workflowPath) === workflowPath &&
		normalizeConfiguredValue(rule.jobName) === jobName &&
		rule.stepNames.some((stepName) =>
			failedStepNames.includes(normalizeConfiguredValue(stepName)),
		)
	);
}

function normalizeWorkflowPath(value: string | null | undefined) {
	const trimmed = (value ?? "").trim();
	return trimmed.replace(/@.+$/, "");
}

function normalizeConfiguredValue(value: string | null | undefined) {
	return (value ?? "").trim();
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}
