import type { Client } from "@libsql/client";

import { fetchProjectIssueWorkItems, type GitHubProjectIssueWorkItem } from "@/lib/github/project-items";
import { createClaimedManualRun, getStateSummary } from "@/lib/state";
import { loadRhapsodyConfig } from "@/lib/config";

type SchedulerTickCreatedRun = {
	workItemId: string;
	runId: string;
	attemptId: string;
	issueNumber: number;
	acquired: boolean;
	claimExpiresAt: number;
};

type SchedulerTickSkippedIssue = {
	workItemId: string;
	issueNumber: number;
	reason: string;
	existingRunId?: string | null;
};

export type SchedulerTickResponse = {
	scanned: number;
	eligible: number;
	created: number;
	skipped: number;
	executed: boolean;
	execution: {
		triggered: boolean;
		reason: string;
	};
	limits: {
		maxConcurrentRuns: number;
		activeClaimCount: number;
		availableSlots: number;
		schedulerStatuses: string[];
		configuredActiveStatuses: string[];
	};
	createdRuns: SchedulerTickCreatedRun[];
	skippedIssues: SchedulerTickSkippedIssue[];
};

type SchedulerTickErrorResponse = {
	error: string;
	detail: { name: string; message: string };
};

export type SchedulerTickResult =
	| { ok: true; value: SchedulerTickResponse }
	| { ok: false; status: number; value: SchedulerTickErrorResponse };

// MVP decision: only auto-schedule Todo items, even though tracker.activeStatuses may include additional values.
const SCHEDULER_STATUS_FILTER = ["Todo"];

export async function runSchedulerTick(client: Client): Promise<SchedulerTickResult> {
	const config = loadRhapsodyConfig();

	try {
		const stateSummary = await getStateSummary(client);
		const maxConcurrentRuns = config.scheduler.maxConcurrentRuns;
		const availableSlots = Math.max(0, maxConcurrentRuns - stateSummary.activeClaimCount);

		let projectItems: GitHubProjectIssueWorkItem[];

		try {
			projectItems = await fetchProjectIssueWorkItems({
				owner: config.tracker.owner,
				repository: config.tracker.repository,
				projectNumber: config.tracker.projectNumber,
				statusField: config.tracker.statusField,
			});
		} catch (error) {
			return {
				ok: false,
				status: 502,
				value: {
					error: "Failed to fetch GitHub Project items.",
					detail: serializeError(error),
				},
			};
		}

		const eligibleItems = projectItems.filter((item) => SCHEDULER_STATUS_FILTER.includes(item.projectStatus ?? ""));
		let remainingSlots = availableSlots;
		const createdRuns: SchedulerTickCreatedRun[] = [];
		const skippedIssues: SchedulerTickSkippedIssue[] = [];

		for (const item of eligibleItems) {
			const workItemId = `github_issue:${item.repository.owner}/${item.repository.name}#${item.issueNumber}`;

			if (remainingSlots <= 0) {
				skippedIssues.push({
					workItemId,
					issueNumber: item.issueNumber,
					reason: "concurrencyLimit",
				});
				continue;
			}

			const result = await createClaimedManualRun(client, {
				workItemId,
				workItemTitle: item.issueTitle,
				workItemUrl: item.issueUrl,
				workItemStatus: item.issueState,
				workItemSnapshot: buildWorkItemSnapshot(config, item),
				runner: config.runner,
				claimedBy: "scheduler",
				claimTtlMs: config.scheduler.claimTtlMs,
			});

			if (result.acquired) {
				createdRuns.push({
					workItemId,
					runId: result.runId,
					attemptId: result.attemptId,
					issueNumber: item.issueNumber,
					acquired: true,
					claimExpiresAt: result.claimExpiresAt,
				});
				remainingSlots -= 1;
				continue;
			}

			skippedIssues.push({
				workItemId,
				issueNumber: item.issueNumber,
				reason: "alreadyClaimed",
				existingRunId: result.existingRunId,
			});
		}

		return {
			ok: true,
			value: {
				scanned: projectItems.length,
				eligible: eligibleItems.length,
				created: createdRuns.length,
				skipped: skippedIssues.length,
				executed: false,
				execution: {
					triggered: false,
					reason: "Execution deferred. Use existing run endpoint or scheduler worker for async execution.",
				},
				limits: {
					maxConcurrentRuns,
					activeClaimCount: stateSummary.activeClaimCount,
					availableSlots,
					schedulerStatuses: SCHEDULER_STATUS_FILTER,
					configuredActiveStatuses: config.tracker.activeStatuses,
				},
				createdRuns,
				skippedIssues,
			},
		};
	} catch (error) {
		return {
			ok: false,
			status: 500,
			value: {
				error: "Failed to execute scheduler tick.",
				detail: serializeError(error),
			},
		};
	}
}

function buildWorkItemSnapshot(
	config: ReturnType<typeof loadRhapsodyConfig>,
	item: GitHubProjectIssueWorkItem,
) {
	return {
		source: "github_issue",
		repository: {
			owner: config.repository.owner,
			name: config.repository.name,
		},
		issue: {
			number: item.issueNumber,
			title: item.issueTitle,
			body: item.issueBody,
			htmlUrl: item.issueUrl,
			state: item.issueState,
			identifier: `#${item.issueNumber}`,
		},
		projectStatus: item.projectStatus,
	};
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}

	return { name: "UnknownError", message: String(error) };
}
