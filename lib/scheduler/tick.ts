import type { Client } from "@libsql/client";

import {
	fetchProjectIssueWorkItems,
	type GitHubProjectIssueWorkItem,
	updateProjectIssueStatus,
} from "@/lib/github/project-items";
import { getPullRequestCheckSummary } from "@/lib/github/checks";
import {
	createClaimedManualRun,
	createDecision,
	createEvent,
	createLink,
	createWorkerRun,
	getStateSummary,
	listWorkItemGraph,
	type Decision,
} from "@/lib/state";
import {
	findPullRequestArtifactFromArtifacts,
	runPostPrCurator,
} from "@/lib/workers/post-pr-curator";
import {
	linkIntakeToBuilder,
	runIntakeCurator as runIntakeCuratorNode,
} from "@/lib/workers/intake-curator";
import {
	buildRepairPlanFromRepairDecision,
	buildFailureFingerprint,
	runRepairerPlanner,
} from "@/lib/workers/repairer";
import { runRepairerExecutor } from "@/lib/workers/repairer/format-executor";
import { loadRhapsodyConfig } from "@/lib/config";

type SchedulerTickCreatedRun = {
	workItemId: string;
	runId: string;
	attemptId: string;
	issueNumber: number;
	builderWorkerRunId: string | null;
	acquired: boolean;
	claimExpiresAt: number;
	projectStatusUpdate: {
		attempted: boolean;
		targetStatus: string;
		updated: boolean;
		error?: { name: string; message: string };
	};
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

export type SchedulerTickDependencies = {
	config?: ReturnType<typeof loadRhapsodyConfig>;
	fetchProjectIssueWorkItems?: typeof fetchProjectIssueWorkItems;
	updateProjectIssueStatus?: typeof updateProjectIssueStatus;
	getPullRequestCheckSummary?: typeof getPullRequestCheckSummary;
	runRepairerPlanner?: typeof runRepairerPlanner;
	runRepairerExecutor?: typeof runRepairerExecutor;
	runIntakeCurator?: typeof runIntakeCuratorNode;
};

const ACTIVE_STATUSES = ["Todo", "In Progress"];
const RUNNING_PROJECT_STATUS = "In Progress";

export async function runSchedulerTick(
	client: Client,
	dependencies: SchedulerTickDependencies = {},
): Promise<SchedulerTickResult> {
	const config = dependencies.config ?? loadRhapsodyConfig();
	const fetchWorkItems =
		dependencies.fetchProjectIssueWorkItems ?? fetchProjectIssueWorkItems;
	const updateIssueStatus =
		dependencies.updateProjectIssueStatus ?? updateProjectIssueStatus;

	try {
		const stateSummary = await getStateSummary(client);
		const maxConcurrentRuns = config.scheduler.maxConcurrentRuns;
		const availableSlots = Math.max(
			0,
			maxConcurrentRuns - stateSummary.activeClaimCount,
		);

		let projectItems: GitHubProjectIssueWorkItem[];

		try {
			projectItems = await fetchWorkItems({
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

		const schedulerStatuses = Array.from(
			new Set([...ACTIVE_STATUSES, ...config.tracker.activeStatuses]),
		);
		const eligibleItems = projectItems.filter((item) =>
			schedulerStatuses.includes(item.projectStatus ?? ""),
		);
		let remainingSlots = availableSlots;
		const createdRuns: SchedulerTickCreatedRun[] = [];
		const skippedIssues: SchedulerTickSkippedIssue[] = [];

		for (const item of eligibleItems) {
			const workItemId = `github_issue:${item.repository.owner}/${item.repository.name}#${item.issueNumber}`;
			const projectStatus = item.projectStatus ?? "";
			const isTodo = projectStatus === "Todo";
			const isInProgress = projectStatus === "In Progress";

			if (isInProgress) {
				const postPrHandled = await runPostPrCuratorForInProgress(
					client,
					config,
					dependencies.getPullRequestCheckSummary,
					dependencies.runRepairerPlanner,
					dependencies.runRepairerExecutor,
					item,
					workItemId,
				);

				if (!postPrHandled.handled) {
					skippedIssues.push({
						workItemId,
						issueNumber: item.issueNumber,
						reason: postPrHandled.skipReason,
					});
				}

				continue;
			}

			if (!isTodo) {
				continue;
			}

			if (remainingSlots <= 0) {
				skippedIssues.push({
					workItemId,
					issueNumber: item.issueNumber,
					reason: "concurrencyLimit",
				});
				continue;
			}

			const graph = await listWorkItemGraph(client, workItemId);
			const runIntakeCurator =
				dependencies.runIntakeCurator ?? runIntakeCuratorNode;
			const intakeResult = await runIntakeCurator(client, item, workItemId, {
				existingDecisions: graph.decisions,
			});
			if (!intakeResult.shouldStartBuilder) {
				skippedIssues.push({
					workItemId,
					issueNumber: item.issueNumber,
					reason: intakeResult.outcome,
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
				const builderWorkerRunId = await createBuilderWorkerRun({
					client,
					config,
					workItemId,
					workItem: item,
					runId: result.runId,
					attemptId: result.attemptId,
					claimToken: result.claimToken,
				});
				if (builderWorkerRunId && intakeResult.decisionId) {
					await linkIntakeToBuilder(
						client,
						workItemId,
						intakeResult.decisionId,
						builderWorkerRunId,
					);
				}
				const projectStatusUpdate = await moveProjectIssueToRunningStatus(
					client,
					{
						config,
						updateProjectIssueStatus: updateIssueStatus,
						item,
						runId: result.runId,
						attemptId: result.attemptId,
					},
				);

				createdRuns.push({
					workItemId,
					runId: result.runId,
					attemptId: result.attemptId,
					issueNumber: item.issueNumber,
					builderWorkerRunId,
					acquired: true,
					claimExpiresAt: result.claimExpiresAt,
					projectStatusUpdate,
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
					reason:
						"Execution deferred. Use existing run endpoint or scheduler worker for async execution.",
				},
				limits: {
					maxConcurrentRuns,
					activeClaimCount: stateSummary.activeClaimCount,
					availableSlots,
					schedulerStatuses,
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

async function moveProjectIssueToRunningStatus(
	client: Client,
	input: {
		config: ReturnType<typeof loadRhapsodyConfig>;
		updateProjectIssueStatus: typeof updateProjectIssueStatus;
		item: GitHubProjectIssueWorkItem;
		runId: string;
		attemptId: string;
	},
) {
	const targetStatus = RUNNING_PROJECT_STATUS;

	try {
		const result = await input.updateProjectIssueStatus({
			owner: input.config.tracker.owner,
			repository: input.config.tracker.repository,
			projectNumber: input.config.tracker.projectNumber,
			statusField: input.config.tracker.statusField,
			issueNumber: input.item.issueNumber,
			status: targetStatus,
		});

		await createEvent(client, {
			runId: input.runId,
			attemptId: input.attemptId,
			level: "info",
			type: "scheduler.project_status_updated",
			message: "Scheduler moved the Project item to the running status.",
			data: {
				issueNumber: input.item.issueNumber,
				fromStatus: input.item.projectStatus,
				toStatus: targetStatus,
				projectItemId: result.itemId,
				fieldId: result.fieldId,
				optionId: result.optionId,
			},
		});

		return {
			attempted: true,
			targetStatus,
			updated: true,
		};
	} catch (error) {
		const detail = serializeError(error);

		await createEvent(client, {
			runId: input.runId,
			attemptId: input.attemptId,
			level: "warn",
			type: "scheduler.project_status_update_failed",
			message:
				"Scheduler could not move the Project item to the running status.",
			data: {
				issueNumber: input.item.issueNumber,
				fromStatus: input.item.projectStatus,
				toStatus: targetStatus,
				error: detail,
			},
		});

		return {
			attempted: true,
			targetStatus,
			updated: false,
			error: detail,
		};
	}
}

type BuilderRunInputs = {
	client: Client;
	config: ReturnType<typeof loadRhapsodyConfig>;
	workItemId: string;
	workItem: GitHubProjectIssueWorkItem;
	runId: string;
	attemptId: string;
	claimToken: string;
};

async function createBuilderWorkerRun(
	input: BuilderRunInputs,
): Promise<string | null> {
	try {
		const builderRun = await createWorkerRun(input.client, {
			workItemId: input.workItemId,
			kind: "builder",
			status: "pending",
			claimToken: input.claimToken,
			metadata: {
				legacyRunId: input.runId,
				legacyAttemptId: input.attemptId,
				issueNumber: input.workItem.issueNumber,
				runner: input.config.runner,
			},
			workItemSnapshot: buildWorkItemSnapshot(input.config, input.workItem),
		});
		const schedulerDecisionId = await createDecision(input.client, {
			workItemId: input.workItemId,
			workerRunId: builderRun.id,
			phase: "dispatch",
			outcome: "start_builder",
			deterministic: true,
			evidence: {
				projectStatus: input.workItem.projectStatus,
				configuredMaxConcurrentRuns: input.config.scheduler.maxConcurrentRuns,
			},
			nextWorkerKind: "builder",
		});

		await Promise.all([
			createLink(input.client, {
				workItemId: input.workItemId,
				fromNodeType: "decision",
				fromNodeId: schedulerDecisionId,
				toNodeType: "worker_run",
				toNodeId: builderRun.id,
				relation: "starts",
				metadata: {
					legacyRunId: input.runId,
				},
			}),
			createLink(input.client, {
				workItemId: input.workItemId,
				fromNodeType: "worker_run",
				fromNodeId: builderRun.id,
				toNodeType: "legacy_run",
				toNodeId: input.runId,
				relation: "executes_legacy_run",
				metadata: {
					legacyRunKind: "legacy_runs",
				},
			}),
			createLink(input.client, {
				workItemId: input.workItemId,
				fromNodeType: "worker_run",
				fromNodeId: builderRun.id,
				toNodeType: "legacy_attempt",
				toNodeId: input.attemptId,
				relation: "executes_legacy_attempt",
				metadata: {
					legacyRunId: input.runId,
				},
			}),
		]);

		return builderRun.id;
	} catch (error) {
		await createEvent(input.client, {
			runId: input.runId,
			attemptId: input.attemptId,
			level: "warn",
			type: "scheduler.builder_worker_graph_failed",
			message:
				"Scheduler could not persist builder worker graph records; continuing with legacy runner dispatch.",
			data: {
				error: serializeError(error),
				issueNumber: input.workItem.issueNumber,
				workItemId: input.workItemId,
			},
		});

		return null;
	}
}

async function runPostPrCuratorForInProgress(
	client: Client,
	config: ReturnType<typeof loadRhapsodyConfig>,
	getPullRequestCheckSummaryDependency:
		| typeof getPullRequestCheckSummary
		| undefined,
	runRepairerPlannerDependency: typeof runRepairerPlanner | undefined,
	runRepairerExecutorDependency: typeof runRepairerExecutor | undefined,
	item: GitHubProjectIssueWorkItem,
	workItemId: string,
) {
	try {
		const graph = await listWorkItemGraph(client, workItemId);
		const pullRequestArtifact = findPullRequestArtifactFromArtifacts(
			graph.artifacts,
		);

		if (!pullRequestArtifact) {
			return {
				handled: false,
				skipReason: "missing_pr_artifact",
			};
		}

		const postPrResult = await runPostPrCurator(client, {
			workItem: item,
			workItemId,
			owner: config.repository.owner,
			repository: config.repository.name,
			pullRequestNumber: pullRequestArtifact.number,
			pullRequestUrl: pullRequestArtifact.url ?? "",
			existingDecisions: graph.decisions,
			getPullRequestCheckSummary: getPullRequestCheckSummaryDependency,
		});
		if (
			postPrResult.classification === "ci_failed" &&
			!postPrResult.skippedFreshDuplicate
		) {
			const planner = runRepairerPlannerDependency ?? runRepairerPlanner;
			const plan = await planner(client, {
				workItem: item,
				workItemId,
				postPrDecisionId: postPrResult.decisionId,
				pullRequestNumber: pullRequestArtifact.number,
				pullRequestUrl: pullRequestArtifact.url ?? "",
				checkSummary: postPrResult.checkSummary,
				existingDecisions: graph.decisions,
			});

			if (plan.outcome === "repair_allowed") {
				await (runRepairerExecutorDependency ?? runRepairerExecutor)({
					client,
					workItem: item,
					workItemId,
					pullRequestNumber: pullRequestArtifact.number,
					pullRequestUrl: pullRequestArtifact.url ?? "",
					checkSummary: postPrResult.checkSummary,
					repositoryBaseBranch: config.repository.defaultBranch,
					plan,
					owner: config.repository.owner,
					repository: config.repository.name,
				});
			}
		}

		if (
			postPrResult.classification === "ci_failed" &&
			postPrResult.skippedFreshDuplicate
		) {
			const failureFingerprint = buildFailureFingerprint(
				postPrResult.checkSummary,
			);
			const duplicateAllowedDecision = findLatestRepairAllowedDecision({
				decisions: graph.decisions,
				pullRequestNumber: pullRequestArtifact.number,
				failureFingerprint,
			});

			if (duplicateAllowedDecision) {
				const duplicatePlan = buildRepairPlanFromRepairDecision(
					duplicateAllowedDecision,
				);
				if (duplicatePlan) {
					const planner = runRepairerPlannerDependency ?? runRepairerPlanner;
					const plan = await planner(client, {
						workItem: item,
						workItemId,
						postPrDecisionId: postPrResult.decisionId,
						pullRequestNumber: pullRequestArtifact.number,
						pullRequestUrl: pullRequestArtifact.url ?? "",
						checkSummary: postPrResult.checkSummary,
						existingDecisions: graph.decisions,
					});

					if (plan.outcome !== "repair_allowed") {
						// Budget check blocked repair attempts on this execution key.
						return {
							handled: true,
							skipReason: "",
						};
					}

					await (runRepairerExecutorDependency ?? runRepairerExecutor)({
						client,
						workItem: item,
						workItemId,
						pullRequestNumber: pullRequestArtifact.number,
						pullRequestUrl: pullRequestArtifact.url ?? "",
						checkSummary: postPrResult.checkSummary,
						repositoryBaseBranch: config.repository.defaultBranch,
						plan,
						owner: config.repository.owner,
						repository: config.repository.name,
					});
				}
			}
		}

		return {
			handled: true,
			skipReason: "",
		};
	} catch (error) {
		await createEvent(client, {
			level: "warn",
			type: "scheduler.post_pr_curator_failed",
			runId: null,
			attemptId: null,
			message: "Scheduler could not run post-PR curator.",
			data: {
				workItemId,
				issueNumber: item.issueNumber,
				error: serializeError(error),
			},
		});

		return {
			handled: false,
			skipReason: "post_pr_graph_error",
		};
	}
}

function findLatestRepairAllowedDecision(input: {
	decisions: Decision[];
	pullRequestNumber: number;
	failureFingerprint: string;
}): Decision | null {
	const candidates = input.decisions.filter((candidate) => {
		if (
			candidate.phase !== "repair" ||
			candidate.outcome !== "repair_allowed"
		) {
			return false;
		}
		const evidence = asObject(candidate.evidence);
		return (
			evidence?.pullRequestNumber === input.pullRequestNumber &&
			evidence?.classification === "format_fixable" &&
			evidence?.failureFingerprint === input.failureFingerprint
		);
	});

	if (candidates.length === 0) {
		return null;
	}

	return candidates.sort((left, right) => right.createdAt - left.createdAt)[0];
}

function asObject(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}

	return { name: "UnknownError", message: String(error) };
}
