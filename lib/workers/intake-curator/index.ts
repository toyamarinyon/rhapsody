import type { Client } from "@libsql/client";
import {
	createDecision,
	createLink,
	createWorkerRun,
	updateWorkerRunStatus,
	type Decision,
} from "@/lib/state";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";

export type IntakeCuratorOutcome = "buildable" | "ask_human";

export type IntakeCuratorResult = {
	decisionId: string;
	workerRunId: string | null;
	outcome: IntakeCuratorOutcome;
	nextAction?: string;
	shouldStartBuilder: boolean;
	skippedFreshDuplicate: boolean;
};

export async function runIntakeCurator(
	client: Client,
	workItem: GitHubProjectIssueWorkItem,
	workItemId: string,
	options: { existingDecisions?: Decision[] } = {},
): Promise<IntakeCuratorResult> {
	const buildable = isIntakeBuildable(workItem);
	const outcome: IntakeCuratorOutcome = buildable ? "buildable" : "ask_human";
	const nextAction = buildable
		? undefined
		: "Please add a non-empty title and at least a short body before builder dispatch.";
	const freshDecision = findFreshIntakeDecision({
		decisions: options.existingDecisions ?? [],
		workItem,
		outcome,
	});

	if (freshDecision) {
		return {
			decisionId: freshDecision.id,
			workerRunId: null,
			outcome,
			nextAction,
			shouldStartBuilder: buildable,
			skippedFreshDuplicate: true,
		};
	}

	try {
		const workerRun = await createWorkerRun(client, {
			workItemId,
			kind: "intake_curator",
			status: "completed",
			metadata: {
				issueNumber: workItem.issueNumber,
				issueTitle: workItem.issueTitle,
			},
		});

		const decisionId = await createDecision(client, {
			workItemId,
			workerRunId: workerRun.id,
			phase: "intake",
			outcome,
			deterministic: true,
			nextWorkerKind: buildable ? "builder" : null,
			nextAction,
			evidence: {
				issueTitle: workItem.issueTitle,
				issueBodyPreview: workItem.issueBody?.slice(0, 120) ?? null,
				issueNumber: workItem.issueNumber,
			},
		});

		await updateWorkerRunStatus(client, {
			id: workerRun.id,
			status: "completed",
		});

		return {
			decisionId,
			workerRunId: workerRun.id,
			outcome,
			nextAction,
			shouldStartBuilder: buildable,
			skippedFreshDuplicate: false,
		};
	} catch {
		return {
			decisionId: "",
			workerRunId: null,
			outcome,
			nextAction,
			shouldStartBuilder: buildable,
			skippedFreshDuplicate: false,
		};
	}
}

export async function linkIntakeToBuilder(
	client: Client,
	workItemId: string,
	intakeDecisionId: string,
	builderWorkerRunId: string,
): Promise<void> {
	if (!intakeDecisionId || !builderWorkerRunId) {
		return;
	}

	try {
		await createLink(client, {
			workItemId,
			fromNodeType: "decision",
			fromNodeId: intakeDecisionId,
			toNodeType: "worker_run",
			toNodeId: builderWorkerRunId,
			relation: "starts",
			metadata: {
				curatorPhase: "intake",
			},
		});
	} catch {
		return;
	}
}

export function isIntakeBuildable(item: GitHubProjectIssueWorkItem): boolean {
	const title = (item.issueTitle ?? "").trim();
	const body = (item.issueBody ?? "").trim();

	if (title.length < 4) {
		return false;
	}

	if (!body || body.length < 12) {
		return false;
	}

	return true;
}

function findFreshIntakeDecision(input: {
	decisions: Decision[];
	workItem: GitHubProjectIssueWorkItem;
	outcome: IntakeCuratorOutcome;
}): Decision | null {
	const issueBodyPreview = input.workItem.issueBody?.slice(0, 120) ?? null;

	return (
		input.decisions.find((decision) => {
			if (decision.phase !== "intake" || decision.outcome !== input.outcome) {
				return false;
			}

			const evidence = asRecord(decision.evidence);
			return (
				evidence?.issueNumber === input.workItem.issueNumber &&
				evidence?.issueTitle === input.workItem.issueTitle &&
				evidence?.issueBodyPreview === issueBodyPreview
			);
		}) ?? null
	);
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}
