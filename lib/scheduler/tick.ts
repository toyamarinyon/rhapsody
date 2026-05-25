import type { Client } from "@libsql/client";
import { loadRhapsodyConfig } from "@/lib/config";
import type {
	getPullRequestCheckSummary,
	PullRequestCheckSummary,
} from "@/lib/github/checks";
import {
	fetchProjectIssueWorkItems,
	type GitHubProjectIssueWorkItem,
	updateProjectIssueStatus,
} from "@/lib/github/project-items";
import {
	getPullRequest,
	getPullRequestChangedFiles,
	mergePullRequest,
} from "@/lib/github/pull-requests";
import {
	evaluatePostRunDecision,
	getPostRunStatusConfig,
	loadPostRunDecisionConfig,
} from "@/lib/post-run-decision";
import {
	createClaimedManualRun,
	createDecision,
	createEvent,
	createLink,
	createWorkerRun,
	type Decision,
	type WorkItemGraph,
	getStateSummary,
	listWorkItemGraph,
} from "@/lib/state";
import {
	linkIntakeToBuilder,
	runIntakeCurator as runIntakeCuratorNode,
} from "@/lib/workers/intake-curator";
import {
	findPullRequestArtifactFromArtifacts,
	runPostPrCurator,
} from "@/lib/workers/post-pr-curator";
import {
	buildFailureFingerprint,
	buildRepairExecutionKey,
	buildRepairPlanFromRepairDecision,
	runRepairerPlanner,
} from "@/lib/workers/repairer";
import { runRepairerExecutor } from "@/lib/workers/repairer/format-executor";

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
	getPullRequest?: typeof getPullRequest;
	getPullRequestChangedFiles?: typeof getPullRequestChangedFiles;
	mergePullRequest?: typeof mergePullRequest;
	loadPostRunDecisionConfig?: typeof loadPostRunDecisionConfig;
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
					{
						getPullRequest: dependencies.getPullRequest,
						getPullRequestCheckSummary: dependencies.getPullRequestCheckSummary,
						getPullRequestChangedFiles: dependencies.getPullRequestChangedFiles,
						mergePullRequest: dependencies.mergePullRequest,
						loadPostRunDecisionConfig: dependencies.loadPostRunDecisionConfig,
						runRepairerPlanner: dependencies.runRepairerPlanner,
						runRepairerExecutor: dependencies.runRepairerExecutor,
						updateProjectIssueStatus: updateIssueStatus,
					},
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
				runner: config.runner.kind,
				claimedBy: "scheduler",
				claimTtlMs: config.runner.claimTtlMs,
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
				runner: input.config.runner.kind,
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

type SchedulerPostPrDependencies = {
	getPullRequest?: typeof getPullRequest;
	getPullRequestCheckSummary?: typeof getPullRequestCheckSummary;
	getPullRequestChangedFiles?: typeof getPullRequestChangedFiles;
	mergePullRequest?: typeof mergePullRequest;
	loadPostRunDecisionConfig?: typeof loadPostRunDecisionConfig;
	runRepairerPlanner?: typeof runRepairerPlanner;
	runRepairerExecutor?: typeof runRepairerExecutor;
	updateProjectIssueStatus: typeof updateProjectIssueStatus;
};

async function runPostPrCuratorForInProgress(
	client: Client,
	config: ReturnType<typeof loadRhapsodyConfig>,
	dependencies: SchedulerPostPrDependencies,
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
			getPullRequestCheckSummary: dependencies.getPullRequestCheckSummary,
		});
		const postPrWorkerRunId =
			postPrResult.workerRunId ??
			graph.decisions.find(
				(decision) => decision.id === postPrResult.decisionId,
			)?.workerRunId ??
			null;

		if (postPrResult.classification === "checks_unknown") {
			await moveUnknownChecksItemToHumanReview({
				client,
				config,
				dependencies,
				item,
				workItemId,
				postPrDecisionId: postPrResult.decisionId,
				postPrWorkerRunId,
				pullRequestArtifact,
				checkSummary: postPrResult.checkSummary,
			});
		}

		if (postPrResult.classification === "checks_success") {
			await applyChecksSuccessPostPrPolicy({
				client,
				config,
				dependencies,
				item,
				workItemId,
				postPrDecisionId: postPrResult.decisionId,
				postPrWorkerRunId,
				pullRequestArtifact,
			});
		}

		if (postPrResult.classification === "ci_failed") {
			await handleFailedPostPrChecks({
				client,
				config,
				dependencies,
				item,
				workItemId,
				graph,
				graphDecisions: graph.decisions,
				postPrDecisionId: postPrResult.decisionId,
				postPrWorkerRunId,
				pullRequestArtifact,
				checkSummary: postPrResult.checkSummary,
				skippedFreshDuplicate: postPrResult.skippedFreshDuplicate,
			});
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

async function applyChecksSuccessPostPrPolicy(input: {
	client: Client;
	config: ReturnType<typeof loadRhapsodyConfig>;
	dependencies: SchedulerPostPrDependencies;
	item: GitHubProjectIssueWorkItem;
	workItemId: string;
	postPrDecisionId: string;
	postPrWorkerRunId: string | null;
	pullRequestArtifact: { id: string; number: number; url: string | null };
}) {
	const policyLoadResult = await loadSchedulerPostRunPolicy(
		input.dependencies.loadPostRunDecisionConfig,
	);
	const statusConfig = getPostRunStatusConfig(policyLoadResult.config);

	if (policyLoadResult.errors.length > 0) {
		await createEvent(input.client, {
			runId: null,
			attemptId: null,
			level: "warn",
			type: "scheduler.post_run_policy_load_fallback",
			message:
				"Post-run policy file was unavailable; using conservative review-required policy.",
			data: {
				errors: policyLoadResult.errors,
				loadedFromPath: policyLoadResult.loadedFromPath,
				configuredRules:
					policyLoadResult.config.post_run.auto_merge_eligible.length,
				pullRequestNumber: input.pullRequestArtifact.number,
				issueNumber: input.item.issueNumber,
			},
		});
	}

	let changedFiles: string[] | null = null;

	try {
		changedFiles = await (
			input.dependencies.getPullRequestChangedFiles ??
			getPullRequestChangedFiles
		)({
			owner: input.config.repository.owner,
			repository: input.config.repository.name,
			pullRequestNumber: input.pullRequestArtifact.number,
		});
	} catch (error) {
		await createEvent(input.client, {
			runId: null,
			attemptId: null,
			level: "warn",
			type: "scheduler.pull_request_changed_files_failed",
			message:
				"Scheduler could not load changed files for post-run policy evaluation.",
			data: {
				issueNumber: input.item.issueNumber,
				pullRequestNumber: input.pullRequestArtifact.number,
				error: serializeError(error),
			},
		});
	}

	const decision = evaluatePostRunDecision({
		runStatus: "completed",
		attemptStatus: "completed",
		handoffStatus: "ok",
		changedFiles,
		config: policyLoadResult.config,
	});

	await createEvent(input.client, {
		runId: null,
		attemptId: null,
		level: "info",
		type: "scheduler.post_run_decision",
		message: "Scheduler evaluated post-run decision policy.",
		data: {
			decision,
			issueNumber: input.item.issueNumber,
			pullRequestNumber: input.pullRequestArtifact.number,
			changedFileCount: changedFiles?.length ?? null,
			loadedFromPath: policyLoadResult.loadedFromPath,
		},
	});

	if (decision.action === "auto_merge_candidate") {
		await mergePullRequestAndMarkDone({
			client: input.client,
			config: input.config,
			dependencies: input.dependencies,
			item: input.item,
			workItemId: input.workItemId,
			postPrDecisionId: input.postPrDecisionId,
			postPrWorkerRunId: input.postPrWorkerRunId,
			pullRequestArtifact: input.pullRequestArtifact,
			postRunDecision: decision,
			policyLoadedFromPath: policyLoadResult.loadedFromPath,
			targetStatus: statusConfig.autoMergeSuccessStatus,
		});
		return;
	}

	const moved = await moveProjectItemToStatus({
		client: input.client,
		config: input.config,
		updateProjectIssueStatus: input.dependencies.updateProjectIssueStatus,
		item: input.item,
		pullRequestNumber: input.pullRequestArtifact.number,
		targetStatus: statusConfig.humanReviewStatus,
		message: `Scheduler moved the Project item to ${statusConfig.humanReviewStatus} after passing checks required human review.`,
		reason: decision.reason,
	});

	if (!moved) {
		return;
	}

	await recordPostPrResolutionDecision({
		client: input.client,
		workItemId: input.workItemId,
		postPrDecisionId: input.postPrDecisionId,
		postPrWorkerRunId: input.postPrWorkerRunId,
		pullRequestArtifact: input.pullRequestArtifact,
		outcome: "human_review",
		policyRuleId: null,
		nextAction: `Move the Project item to ${statusConfig.humanReviewStatus} after successful checks still required human review.`,
		evidence: {
			checkClassification: "checks_success",
			reason: decision.reason,
			targetStatus: statusConfig.humanReviewStatus,
			postRunDecision: decision,
			loadedFromPath: policyLoadResult.loadedFromPath,
		},
	});
}

async function handleFailedPostPrChecks(input: {
	client: Client;
	config: ReturnType<typeof loadRhapsodyConfig>;
	dependencies: SchedulerPostPrDependencies;
	item: GitHubProjectIssueWorkItem;
	workItemId: string;
	graph: WorkItemGraph;
	graphDecisions: Decision[];
	postPrDecisionId: string;
	postPrWorkerRunId: string | null;
	pullRequestArtifact: { id: string; number: number; url: string | null };
	checkSummary: PullRequestCheckSummary;
	skippedFreshDuplicate: boolean;
}) {
	const failureFingerprint = buildFailureFingerprint(input.checkSummary);
	const repairExecutionKey = buildRepairExecutionKey({
		pullRequestNumber: input.pullRequestArtifact.number,
		headSha: input.checkSummary.headSha,
		failureFingerprint,
	});

	if (
		hasActiveRepairerRunForKey({
			workerRuns: input.graph.workerRuns,
			repairExecutionKey,
		})
	) {
		return;
	}

	if (input.skippedFreshDuplicate) {
		const blockedDecision = findLatestRepairDecision({
			decisions: input.graphDecisions,
			pullRequestNumber: input.pullRequestArtifact.number,
			failureFingerprint,
			outcome: "repair_blocked",
		});
		if (blockedDecision) {
			await moveRepairBlockedItemToHumanReview({
				client: input.client,
				config: input.config,
				dependencies: input.dependencies,
				item: input.item,
				workItemId: input.workItemId,
				postPrDecisionId: input.postPrDecisionId,
				postPrWorkerRunId: input.postPrWorkerRunId,
				pullRequestNumber: input.pullRequestArtifact.number,
				pullRequestArtifact: input.pullRequestArtifact,
				reason:
					blockedDecision.nextAction ??
					"Repair was blocked for this failed check set.",
				repairDecisionId: blockedDecision.id,
				checkSummary: input.checkSummary,
			});
			return;
		}

		const duplicateAllowedDecision = findLatestRepairDecision({
			decisions: input.graphDecisions,
			pullRequestNumber: input.pullRequestArtifact.number,
			failureFingerprint,
			outcome: "repair_allowed",
		});
		if (duplicateAllowedDecision) {
			const duplicatePlan = buildRepairPlanFromRepairDecision(
				duplicateAllowedDecision,
			);
			if (duplicatePlan) {
				const plan = await (
					input.dependencies.runRepairerPlanner ?? runRepairerPlanner
				)(input.client, {
					workItem: input.item,
					workItemId: input.workItemId,
					postPrDecisionId: input.postPrDecisionId,
					pullRequestNumber: input.pullRequestArtifact.number,
					pullRequestUrl: input.pullRequestArtifact.url ?? "",
					checkSummary: input.checkSummary,
					existingDecisions: input.graphDecisions,
				});

				if (plan.outcome !== "repair_allowed") {
					await moveRepairBlockedItemToHumanReview({
						client: input.client,
						config: input.config,
						dependencies: input.dependencies,
						item: input.item,
						workItemId: input.workItemId,
						postPrDecisionId: input.postPrDecisionId,
						postPrWorkerRunId: input.postPrWorkerRunId,
						pullRequestNumber: input.pullRequestArtifact.number,
						pullRequestArtifact: input.pullRequestArtifact,
						reason:
							"Repair budget was exhausted or the failure was no longer safely repairable.",
						repairDecisionId: plan.decisionId,
						checkSummary: input.checkSummary,
					});
					return;
				}

				await (input.dependencies.runRepairerExecutor ?? runRepairerExecutor)({
					client: input.client,
					workItem: input.item,
					workItemId: input.workItemId,
					pullRequestNumber: input.pullRequestArtifact.number,
					pullRequestUrl: input.pullRequestArtifact.url ?? "",
					checkSummary: input.checkSummary,
					repositoryBaseBranch: input.config.repository.defaultBranch,
					plan,
					owner: input.config.repository.owner,
					repository: input.config.repository.name,
				});
				return;
			}
		}
	}

	const plan = await (
		input.dependencies.runRepairerPlanner ?? runRepairerPlanner
	)(input.client, {
		workItem: input.item,
		workItemId: input.workItemId,
		postPrDecisionId: input.postPrDecisionId,
		pullRequestNumber: input.pullRequestArtifact.number,
		pullRequestUrl: input.pullRequestArtifact.url ?? "",
		checkSummary: input.checkSummary,
		existingDecisions: input.graphDecisions,
	});

	if (plan.outcome === "repair_allowed") {
		await (input.dependencies.runRepairerExecutor ?? runRepairerExecutor)({
			client: input.client,
			workItem: input.item,
			workItemId: input.workItemId,
			pullRequestNumber: input.pullRequestArtifact.number,
			pullRequestUrl: input.pullRequestArtifact.url ?? "",
			checkSummary: input.checkSummary,
			repositoryBaseBranch: input.config.repository.defaultBranch,
			plan,
			owner: input.config.repository.owner,
			repository: input.config.repository.name,
		});
		return;
	}

	await moveRepairBlockedItemToHumanReview({
		client: input.client,
		config: input.config,
		dependencies: input.dependencies,
		item: input.item,
		workItemId: input.workItemId,
		postPrDecisionId: input.postPrDecisionId,
		postPrWorkerRunId: input.postPrWorkerRunId,
		pullRequestNumber: input.pullRequestArtifact.number,
		pullRequestArtifact: input.pullRequestArtifact,
		reason:
			"Repair was blocked because the failed checks were not safely format-fixable or the repair budget was exhausted.",
		repairDecisionId: plan.decisionId,
		checkSummary: input.checkSummary,
	});
}

async function moveRepairBlockedItemToHumanReview(input: {
	client: Client;
	config: ReturnType<typeof loadRhapsodyConfig>;
	dependencies: SchedulerPostPrDependencies;
	item: GitHubProjectIssueWorkItem;
	workItemId: string;
	postPrDecisionId: string;
	postPrWorkerRunId: string | null;
	pullRequestNumber: number;
	pullRequestArtifact: { id: string; number: number; url: string | null };
	reason: string;
	repairDecisionId: string;
	checkSummary: PullRequestCheckSummary;
}) {
	const policyLoadResult = await loadSchedulerPostRunPolicy(
		input.dependencies.loadPostRunDecisionConfig,
	);
	const statusConfig = getPostRunStatusConfig(policyLoadResult.config);

	if (policyLoadResult.errors.length > 0) {
		await createEvent(input.client, {
			runId: null,
			attemptId: null,
			level: "warn",
			type: "scheduler.post_run_policy_load_fallback",
			message:
				"Post-run policy file was unavailable; using conservative review-required policy.",
			data: {
				errors: policyLoadResult.errors,
				loadedFromPath: policyLoadResult.loadedFromPath,
				configuredRules:
					policyLoadResult.config.post_run.auto_merge_eligible.length,
				pullRequestNumber: input.pullRequestNumber,
				issueNumber: input.item.issueNumber,
			},
		});
	}

	const moved = await moveProjectItemToStatus({
		client: input.client,
		config: input.config,
		updateProjectIssueStatus: input.dependencies.updateProjectIssueStatus,
		item: input.item,
		pullRequestNumber: input.pullRequestNumber,
		targetStatus: statusConfig.humanReviewStatus,
		message: `Scheduler moved the Project item to ${statusConfig.humanReviewStatus} after repair was blocked.`,
		reason: input.reason,
	});

	if (!moved) {
		return;
	}

	await recordPostPrResolutionDecision({
		client: input.client,
		workItemId: input.workItemId,
		postPrDecisionId: input.postPrDecisionId,
		postPrWorkerRunId: input.postPrWorkerRunId,
		pullRequestArtifact: input.pullRequestArtifact,
		outcome: "human_review",
		policyRuleId: "repair_blocked",
		nextAction: `Move the Project item to ${statusConfig.humanReviewStatus} because repair was blocked.`,
		evidence: {
			checkClassification: "ci_failed",
			reason: input.reason,
			targetStatus: statusConfig.humanReviewStatus,
			repairDecisionId: input.repairDecisionId,
			checkSummary: input.checkSummary,
			loadedFromPath: policyLoadResult.loadedFromPath,
		},
	});
}

type PullRequestSuccessReconciliation =
	| {
			outcome: "merged";
			mergeResult: Awaited<ReturnType<typeof mergePullRequest>>;
	  }
	| {
			outcome: "already_merged";
			pullRequest: Awaited<ReturnType<typeof getPullRequest>>;
	  };

async function reconcilePullRequestSuccess(input: {
	config: ReturnType<typeof loadRhapsodyConfig>;
	dependencies: SchedulerPostPrDependencies;
	pullRequestArtifact: { id: string; number: number; url: string | null };
}): Promise<PullRequestSuccessReconciliation> {
	const loadPullRequest = input.dependencies.getPullRequest ?? getPullRequest;
	const mergeTrustedPullRequest =
		input.dependencies.mergePullRequest ?? mergePullRequest;
	const pullRequest = await loadPullRequest({
		owner: input.config.repository.owner,
		repository: input.config.repository.name,
		pullRequestNumber: input.pullRequestArtifact.number,
	});

	if (pullRequest.merged) {
		return {
			outcome: "already_merged",
			pullRequest,
		};
	}

	if (pullRequest.state !== "open") {
		throw new Error("Trusted pull request is closed without merge.");
	}

	let mergeResult: Awaited<ReturnType<typeof mergePullRequest>>;
	try {
		mergeResult = await mergeTrustedPullRequest({
			owner: input.config.repository.owner,
			repository: input.config.repository.name,
			pullRequestNumber: input.pullRequestArtifact.number,
		});
	} catch (error) {
		const refreshedPullRequest = await tryReloadPullRequestForSuccess(input);
		if (refreshedPullRequest?.merged) {
			return {
				outcome: "already_merged",
				pullRequest: refreshedPullRequest,
			};
		}
		if (refreshedPullRequest && refreshedPullRequest.state !== "open") {
			throw new Error("Trusted pull request is closed without merge.");
		}
		throw error;
	}

	if (mergeResult.merged) {
		return {
			outcome: "merged",
			mergeResult,
		};
	}

	const refreshedPullRequest = await tryReloadPullRequestForSuccess(input);
	if (refreshedPullRequest?.merged) {
		return {
			outcome: "already_merged",
			pullRequest: refreshedPullRequest,
		};
	}
	if (refreshedPullRequest && refreshedPullRequest.state !== "open") {
		throw new Error("Trusted pull request is closed without merge.");
	}

	throw new Error(
		mergeResult.message.trim().length > 0
			? `GitHub reported the trusted pull request was not merged: ${mergeResult.message}`
			: "GitHub reported the trusted pull request was not merged.",
	);
}

async function tryReloadPullRequestForSuccess(input: {
	config: ReturnType<typeof loadRhapsodyConfig>;
	dependencies: SchedulerPostPrDependencies;
	pullRequestArtifact: { id: string; number: number; url: string | null };
}) {
	try {
		return await (input.dependencies.getPullRequest ?? getPullRequest)({
			owner: input.config.repository.owner,
			repository: input.config.repository.name,
			pullRequestNumber: input.pullRequestArtifact.number,
		});
	} catch {
		return null;
	}
}

async function mergePullRequestAndMarkDone(input: {
	client: Client;
	config: ReturnType<typeof loadRhapsodyConfig>;
	dependencies: SchedulerPostPrDependencies;
	item: GitHubProjectIssueWorkItem;
	workItemId: string;
	postPrDecisionId: string;
	postPrWorkerRunId: string | null;
	pullRequestArtifact: { id: string; number: number; url: string | null };
	postRunDecision: ReturnType<typeof evaluatePostRunDecision>;
	policyLoadedFromPath: string;
	targetStatus: string;
}) {
	try {
		const reconciliation = await reconcilePullRequestSuccess({
			config: input.config,
			dependencies: input.dependencies,
			pullRequestArtifact: input.pullRequestArtifact,
		});
		const mergeResult =
			reconciliation.outcome === "merged"
				? reconciliation.mergeResult
				: {
						number: input.pullRequestArtifact.number,
						merged: true,
						message: "Pull request was already merged.",
						sha: reconciliation.pullRequest.sha ?? null,
					};

		if (reconciliation.outcome === "merged") {
			await createEvent(input.client, {
				runId: null,
				attemptId: null,
				level: "info",
				type: "scheduler.pull_request_merged",
				message: "Scheduler merged the trusted pull request.",
				data: {
					issueNumber: input.item.issueNumber,
					pullRequestNumber: input.pullRequestArtifact.number,
					mergeResult: reconciliation.mergeResult,
				},
			});
		} else {
			await createEvent(input.client, {
				runId: null,
				attemptId: null,
				level: "info",
				type: "scheduler.pull_request_already_merged",
				message:
					"Scheduler confirmed the trusted pull request was already merged and continued Project status reconciliation.",
				data: {
					issueNumber: input.item.issueNumber,
					pullRequestNumber: input.pullRequestArtifact.number,
					pullRequestState: reconciliation.pullRequest.state,
					mergedAt: reconciliation.pullRequest.mergedAt,
				},
			});
		}

		const moved = await moveProjectItemToStatus({
			client: input.client,
			config: input.config,
			updateProjectIssueStatus: input.dependencies.updateProjectIssueStatus,
			item: input.item,
			pullRequestNumber: input.pullRequestArtifact.number,
			targetStatus: input.targetStatus,
			message: `Scheduler moved the Project item to ${input.targetStatus} after auto-merging the pull request.`,
		});

		if (!moved) {
			return;
		}

		await recordPostPrResolutionDecision({
			client: input.client,
			workItemId: input.workItemId,
			postPrDecisionId: input.postPrDecisionId,
			postPrWorkerRunId: input.postPrWorkerRunId,
			pullRequestArtifact: input.pullRequestArtifact,
			outcome: "done",
			policyRuleId: getPostRunDecisionRuleId(input.postRunDecision),
			nextAction: `Merge the trusted pull request and move the Project item to ${input.targetStatus}.`,
			evidence: {
				checkClassification: "checks_success",
				targetStatus: input.targetStatus,
				postRunDecision: input.postRunDecision,
				loadedFromPath: input.policyLoadedFromPath,
				mergeResult,
			},
		});
	} catch (error) {
		await createEvent(input.client, {
			runId: null,
			attemptId: null,
			level: "warn",
			type: "scheduler.pull_request_merge_failed",
			message: "Scheduler could not merge the trusted pull request.",
			data: {
				issueNumber: input.item.issueNumber,
				pullRequestNumber: input.pullRequestArtifact.number,
				error: serializeError(error),
			},
		});
	}
}

function hasActiveRepairerRunForKey(input: {
	workerRuns: WorkItemGraph["workerRuns"];
	repairExecutionKey: string;
}) {
	return input.workerRuns.some((run) => {
		if (run.kind !== "repairer") {
			return false;
		}
		if (!["pending", "running"].includes(run.status)) {
			return false;
		}
		const metadata = asObject(run.metadata);
		return metadata?.repairExecutionKey === input.repairExecutionKey;
	});
}

async function moveUnknownChecksItemToHumanReview(input: {
	client: Client;
	config: ReturnType<typeof loadRhapsodyConfig>;
	dependencies: SchedulerPostPrDependencies;
	item: GitHubProjectIssueWorkItem;
	workItemId: string;
	postPrDecisionId: string;
	postPrWorkerRunId: string | null;
	pullRequestArtifact: { id: string; number: number; url: string | null };
	checkSummary: PullRequestCheckSummary;
}) {
	const reason =
		"Pull request checks could not be classified safely, so human review is required.";
	const policyLoadResult = await loadSchedulerPostRunPolicy(
		input.dependencies.loadPostRunDecisionConfig,
	);
	const statusConfig = getPostRunStatusConfig(policyLoadResult.config);

	if (policyLoadResult.errors.length > 0) {
		await createEvent(input.client, {
			runId: null,
			attemptId: null,
			level: "warn",
			type: "scheduler.post_run_policy_load_fallback",
			message:
				"Post-run policy file was unavailable; using conservative review-required policy.",
			data: {
				errors: policyLoadResult.errors,
				loadedFromPath: policyLoadResult.loadedFromPath,
				configuredRules:
					policyLoadResult.config.post_run.auto_merge_eligible.length,
				pullRequestNumber: input.pullRequestArtifact.number,
				issueNumber: input.item.issueNumber,
			},
		});
	}

	const moved = await moveProjectItemToStatus({
		client: input.client,
		config: input.config,
		updateProjectIssueStatus: input.dependencies.updateProjectIssueStatus,
		item: input.item,
		pullRequestNumber: input.pullRequestArtifact.number,
		targetStatus: statusConfig.humanReviewStatus,
		message: `Scheduler moved the Project item to ${statusConfig.humanReviewStatus} because pull request checks were unknown.`,
		reason,
	});

	if (!moved) {
		return;
	}

	await recordPostPrResolutionDecision({
		client: input.client,
		workItemId: input.workItemId,
		postPrDecisionId: input.postPrDecisionId,
		postPrWorkerRunId: input.postPrWorkerRunId,
		pullRequestArtifact: input.pullRequestArtifact,
		outcome: "human_review",
		policyRuleId: "checks_unknown",
		nextAction: `Move the Project item to ${statusConfig.humanReviewStatus} because check classification was unknown.`,
		evidence: {
			checkClassification: "checks_unknown",
			reason,
			targetStatus: statusConfig.humanReviewStatus,
			checkSummary: input.checkSummary,
			loadedFromPath: policyLoadResult.loadedFromPath,
		},
	});
}

async function moveProjectItemToStatus(input: {
	client: Client;
	config: ReturnType<typeof loadRhapsodyConfig>;
	updateProjectIssueStatus: typeof updateProjectIssueStatus;
	item: GitHubProjectIssueWorkItem;
	pullRequestNumber: number;
	targetStatus: string;
	message: string;
	reason?: string;
}) {
	try {
		const result = await input.updateProjectIssueStatus({
			owner: input.config.tracker.owner,
			repository: input.config.tracker.repository,
			projectNumber: input.config.tracker.projectNumber,
			statusField: input.config.tracker.statusField,
			issueNumber: input.item.issueNumber,
			status: input.targetStatus,
		});

		await createEvent(input.client, {
			runId: null,
			attemptId: null,
			level: "info",
			type: "scheduler.project_status_updated",
			message: input.message,
			data: {
				issueNumber: input.item.issueNumber,
				fromStatus: input.item.projectStatus,
				toStatus: input.targetStatus,
				projectItemId: result.itemId,
				fieldId: result.fieldId,
				optionId: result.optionId,
				pullRequestNumber: input.pullRequestNumber,
				reason: input.reason ?? null,
			},
		});

		return true;
	} catch (error) {
		await createEvent(input.client, {
			runId: null,
			attemptId: null,
			level: "warn",
			type: "scheduler.project_status_update_failed",
			message: `Scheduler could not move the Project item to ${input.targetStatus}.`,
			data: {
				issueNumber: input.item.issueNumber,
				fromStatus: input.item.projectStatus,
				toStatus: input.targetStatus,
				pullRequestNumber: input.pullRequestNumber,
				reason: input.reason ?? null,
				error: serializeError(error),
			},
		});

		return false;
	}
}

async function recordPostPrResolutionDecision(input: {
	client: Client;
	workItemId: string;
	postPrDecisionId: string;
	postPrWorkerRunId: string | null;
	pullRequestArtifact: { id: string; number: number; url: string | null };
	outcome: string;
	policyRuleId: string | null;
	nextAction: string;
	evidence: Record<string, unknown>;
}) {
	if (!input.postPrWorkerRunId) {
		return;
	}

	try {
		const resolutionDecisionId = await createDecision(input.client, {
			workItemId: input.workItemId,
			workerRunId: input.postPrWorkerRunId,
			phase: "post_pr",
			outcome: input.outcome,
			deterministic: true,
			policyRuleId: input.policyRuleId,
			nextWorkerKind: null,
			nextAction: input.nextAction,
			evidence: {
				sourceDecisionId: input.postPrDecisionId,
				pullRequestArtifactId: input.pullRequestArtifact.id,
				pullRequestNumber: input.pullRequestArtifact.number,
				pullRequestUrl: input.pullRequestArtifact.url,
				...input.evidence,
			},
		});

		await createLink(input.client, {
			workItemId: input.workItemId,
			fromNodeType: "decision",
			fromNodeId: input.postPrDecisionId,
			toNodeType: "decision",
			toNodeId: resolutionDecisionId,
			relation: "resolves_to",
			metadata: {
				outcome: input.outcome,
				pullRequestNumber: input.pullRequestArtifact.number,
			},
		});
	} catch (error) {
		await createEvent(input.client, {
			runId: null,
			attemptId: null,
			level: "warn",
			type: "scheduler.post_pr_resolution_record_failed",
			message:
				"Scheduler could not record the post-PR resolution decision in the worker graph.",
			data: {
				workItemId: input.workItemId,
				pullRequestNumber: input.pullRequestArtifact.number,
				postPrDecisionId: input.postPrDecisionId,
				outcome: input.outcome,
				error: serializeError(error),
			},
		});
	}
}

async function loadSchedulerPostRunPolicy(
	loadPolicy: typeof loadPostRunDecisionConfig | undefined,
) {
	try {
		return await (loadPolicy ?? loadPostRunDecisionConfig)(process.cwd());
	} catch (error) {
		const message =
			error instanceof Error
				? error.message
				: "Unknown error while loading post-run decision policy.";
		return {
			config: {
				post_run: {
					auto_merge_eligible: [],
					auto_merge_success_status: "Done",
					human_review_status: "Human Review",
				},
			},
			loadedFromPath: ".rhapsody/config.toml",
			errors: [message],
		};
	}
}

function getPostRunDecisionRuleId(
	decision: ReturnType<typeof evaluatePostRunDecision>,
) {
	return decision.ruleIndex === null
		? null
		: `post_run.auto_merge_eligible[${decision.ruleIndex}]`;
}

function findLatestRepairDecision(input: {
	decisions: Decision[];
	pullRequestNumber: number;
	failureFingerprint: string;
	outcome: "repair_allowed" | "repair_blocked";
}): Decision | null {
	const candidates = input.decisions.filter((candidate) => {
		if (candidate.phase !== "repair" || candidate.outcome !== input.outcome) {
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
