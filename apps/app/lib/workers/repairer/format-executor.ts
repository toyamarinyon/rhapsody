import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { loadRhapsodyGitHubEnv } from "@/lib/config";
import {
	expandSandboxNetworkPolicyForPreset,
	loadRunnerCodexConfig,
} from "@/lib/runner-codex-config";
import {
	buildVercelSandboxDependencyNetworkPolicy,
	buildVercelSandboxGitHubNetworkPolicy,
	mergeNetworkPolicies,
	createVercelSandbox,
	runVercelSandboxCommand,
	stopVercelSandbox,
	writeVercelSandboxFiles,
	type RhapsodyVercelSandbox,
	type VercelSandboxCommandSummary,
} from "@/lib/sandbox/vercel";
import {
	getPullRequest,
	getPullRequestChangedFiles,
	type PullRequestSummary,
} from "@/lib/github/pull-requests";
import {
	createArtifact,
	createDecision,
	createLink,
	createWorkerRun,
	listWorkItemGraph,
	updateWorkerRunStatus,
	type WorkItemGraph,
} from "@/lib/state";
import {
	type RepairerAttemptBudgets,
	type RepairerAttemptCounts,
	type RepairerPlannerResult,
	asRepairDecisionRecord,
	hasTerminalRepairDecisionOutcome,
} from "@/lib/workers/repairer";
import type { PullRequestCheckSummary } from "@/lib/github/checks";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";

const SANDBOX_WORKDIR = "/vercel/sandbox";
const REPOSITORY_PATH = "/vercel/sandbox/repository";
const WRAPPER_PATH = "format-repair-wrapper.cjs";
const METADATA_PATH = "metadata.json";
const WRAPPER_SOURCE_PATH = path.join(
	process.cwd(),
	"lib",
	"workers",
	"repairer",
	"format-repair-wrapper.cjs",
);
const SANDBOX_TIMEOUT_MS = 8 * 60 * 1000;
const COMMAND_OUTPUT_PREVIEW_LENGTH = 4000;

type RepairerPlan = Pick<
	RepairerPlannerResult,
	| "decisionId"
	| "repairExecutionKey"
	| "failureFingerprint"
	| "attemptCounts"
	| "maxAttempts"
>;

export type RepairerExecutorOutcome =
	| "repair_applied"
	| "repair_noop"
	| "repair_failed";

export type RepairerExecutorResult = {
	executed: boolean;
	reason?: string;
	workerRunId?: string;
	decisionId?: string;
	artifactId?: string;
	outcome?:
		| RepairerExecutorOutcome
		| "repair_skipped_terminal"
		| "repair_skipped_in_progress";
};

type WrapperOutputArtifact = {
	sha: string;
	htmlUrl: string;
	changedFiles: string[];
};

type WrapperOutput = {
	ok?: boolean;
	outcome: RepairerExecutorOutcome;
	error?: string;
	artifact?: WrapperOutputArtifact;
};

type RepairExecutionContext = {
	repairExecutionKey: string;
	failureFingerprint: string;
	attemptCounts: RepairerAttemptCounts;
	maxAttempts: RepairerAttemptBudgets;
};

type DependencyBag = {
	getPullRequest: typeof getPullRequest;
	getPullRequestChangedFiles: typeof getPullRequestChangedFiles;
	createVercelSandbox: typeof createVercelSandbox;
	runVercelSandboxCommand: typeof runVercelSandboxCommand;
	writeVercelSandboxFiles: typeof writeVercelSandboxFiles;
	stopVercelSandbox: typeof stopVercelSandbox;
};

export type RepairerExecutorInput = {
	client: Client;
	workItem: GitHubProjectIssueWorkItem;
	workItemId: string;
	pullRequestNumber: number;
	pullRequestUrl: string;
	checkSummary: PullRequestCheckSummary;
	repositoryBaseBranch: string;
	plan: RepairerPlan;
	owner: string;
	repository: string;
	dependencies?: Partial<DependencyBag>;
};

export async function runRepairerExecutor(
	input: RepairerExecutorInput,
): Promise<RepairerExecutorResult> {
	const deps = buildDependencies(input.dependencies);
	const graph = await listWorkItemGraph(input.client, input.workItemId);
	const context = asRepairExecutionContext(input.plan);

	if (hasTerminalRepairOutcome(graph, context.repairExecutionKey)) {
		return {
			executed: false,
			outcome: "repair_skipped_terminal",
			reason: "terminal repair outcome already recorded for this execution key",
		};
	}

	if (hasActiveRepairerRun(graph, context.repairExecutionKey)) {
		return {
			executed: false,
			outcome: "repair_skipped_in_progress",
			reason: "active repairer run already exists for this execution key",
		};
	}

	const workerRun = await createWorkerRun(input.client, {
		workItemId: input.workItemId,
		kind: "repairer",
		status: "running",
		metadata: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestNumber,
			repairExecutionKey: context.repairExecutionKey,
			failureFingerprint: context.failureFingerprint,
			attemptCounts: context.attemptCounts,
			maxAttempts: context.maxAttempts,
			pullRequestUrl: input.pullRequestUrl,
			checkSummary: input.checkSummary,
		},
	});

	await createLink(input.client, {
		workItemId: input.workItemId,
		fromNodeType: "decision",
		fromNodeId: input.plan.decisionId,
		toNodeType: "worker_run",
		toNodeId: workerRun.id,
		relation: "starts",
		metadata: {
			repairExecutionKey: context.repairExecutionKey,
		},
	});
	await updateWorkerRunStatus(input.client, {
		id: workerRun.id,
		status: "running",
	});

	let pullRequest: PullRequestSummary | null = null;
	let allowedChangedFiles: string[] = [];
	let allowedChangedFilesSource:
		| "repair_decision"
		| "pull_request_files"
		| "none" = "none";

	try {
		pullRequest = await deps.getPullRequest({
			owner: input.owner,
			repository: input.repository,
			pullRequestNumber: input.pullRequestNumber,
		});
	} catch (error) {
		const lookupError =
			error instanceof Error
				? error.message
				: "Could not load pull request details.";

		const decisionId = await createDecision(input.client, {
			workItemId: input.workItemId,
			workerRunId: workerRun.id,
			phase: "repair",
			outcome: "repair_failed",
			deterministic: true,
			policyRuleId: "format_fixable",
			nextWorkerKind: null,
			nextAction: buildRepairNextAction("repair_failed", lookupError),
			evidence: {
				issueNumber: input.workItem.issueNumber,
				pullRequestNumber: input.pullRequestNumber,
				pullRequestUrl: input.pullRequestUrl,
				classification: "format_fixable",
				checks: {
					headSha: input.checkSummary.headSha,
				},
				repairExecutionKey: context.repairExecutionKey,
				failureFingerprint: context.failureFingerprint,
				attemptCounts: context.attemptCounts,
				maxAttempts: context.maxAttempts,
				allowedChangedFiles,
				allowedChangedFilesSource,
				error: lookupError,
			},
		});

		await createLink(input.client, {
			workItemId: input.workItemId,
			fromNodeType: "worker_run",
			fromNodeId: workerRun.id,
			toNodeType: "decision",
			toNodeId: decisionId,
			relation: "decides",
			metadata: {
				outcome: "repair_failed",
				repairExecutionKey: context.repairExecutionKey,
			},
		});

		await updateWorkerRunStatus(input.client, {
			id: workerRun.id,
			status: "failed",
		});

		return {
			executed: true,
			workerRunId: workerRun.id,
			decisionId,
			outcome: "repair_failed",
			reason: lookupError,
		};
	}

	const configuredAllowedChangedFiles = getAllowedChangedFilesFromGraph(
		graph,
		input.plan.decisionId,
	);
	if (configuredAllowedChangedFiles.length > 0) {
		allowedChangedFiles = configuredAllowedChangedFiles;
		allowedChangedFilesSource = "repair_decision";
	} else {
		try {
			const prFiles = await deps.getPullRequestChangedFiles({
				owner: input.owner,
				repository: input.repository,
				pullRequestNumber: input.pullRequestNumber,
			});
			if (prFiles.length > 0) {
				allowedChangedFiles = prFiles;
				allowedChangedFilesSource = "pull_request_files";
			}
		} catch {
			allowedChangedFiles = [];
		}
	}

	if (allowedChangedFiles.length === 0) {
		const decisionId = await createDecision(input.client, {
			workItemId: input.workItemId,
			workerRunId: workerRun.id,
			phase: "repair",
			outcome: "repair_failed",
			deterministic: true,
			policyRuleId: "format_fixable",
			nextWorkerKind: null,
			nextAction: buildRepairNextAction(
				"repair_failed",
				"No allowed changed files available for repair.",
			),
			evidence: {
				issueNumber: input.workItem.issueNumber,
				pullRequestNumber: input.pullRequestNumber,
				pullRequestUrl: input.pullRequestUrl,
				classification: "format_fixable",
				checks: {
					headSha: input.checkSummary.headSha,
				},
				repairExecutionKey: context.repairExecutionKey,
				failureFingerprint: context.failureFingerprint,
				attemptCounts: context.attemptCounts,
				maxAttempts: context.maxAttempts,
				allowedChangedFiles,
				allowedChangedFilesSource,
				error:
					"No allowed changed files were available for this repair attempt.",
			},
		});

		await createLink(input.client, {
			workItemId: input.workItemId,
			fromNodeType: "worker_run",
			fromNodeId: workerRun.id,
			toNodeType: "decision",
			toNodeId: decisionId,
			relation: "decides",
			metadata: {
				outcome: "repair_failed",
				repairExecutionKey: context.repairExecutionKey,
			},
		});

		await updateWorkerRunStatus(input.client, {
			id: workerRun.id,
			status: "failed",
		});

		return {
			executed: true,
			workerRunId: workerRun.id,
			decisionId,
			outcome: "repair_failed",
			reason:
				"No allowed changed files were available for this repair attempt.",
		};
	}

	let sandbox: RhapsodyVercelSandbox | null = null;
	let outcome: RepairerExecutorOutcome = "repair_failed";
	type CommandSummary = {
		commandId: string;
		cwd: string;
		exitCode: number;
		timedOut?: boolean;
		error?: string;
		stdout: string;
		stderr: string;
	};
	let commandSummary: CommandSummary | null = null;
	let commandArtifact: WrapperOutputArtifact | null = null;
	let commandError: string | null = null;

	try {
		const wrapperSource = await readFile(WRAPPER_SOURCE_PATH, "utf8");
		let networkPolicy: ReturnType<typeof mergeNetworkPolicies> | undefined;
		try {
			let githubPolicy:
				| ReturnType<typeof buildVercelSandboxGitHubNetworkPolicy>
				| undefined;
			let dependencyPolicy:
				| ReturnType<typeof buildVercelSandboxDependencyNetworkPolicy>
				| undefined;

			try {
				githubPolicy = buildVercelSandboxGitHubNetworkPolicy({
					githubToken: loadRhapsodyGitHubEnv().GITHUB_TOKEN,
				});
			} catch {
				githubPolicy = undefined;
			}

			try {
				const runnerCodexConfig = await loadRunnerCodexConfig();
				dependencyPolicy = buildVercelSandboxDependencyNetworkPolicy(
					expandSandboxNetworkPolicyForPreset(
						runnerCodexConfig.config?.sandbox?.networkPolicy,
					),
				);
			} catch {
				dependencyPolicy = undefined;
			}

			if (githubPolicy && dependencyPolicy) {
				networkPolicy = mergeNetworkPolicies(githubPolicy, dependencyPolicy);
			} else {
				networkPolicy = githubPolicy ?? dependencyPolicy;
			}
		} catch {
			networkPolicy = undefined;
		}
		sandbox = await deps.createVercelSandbox({
			timeout: SANDBOX_TIMEOUT_MS,
			networkPolicy,
		});

		await deps.writeVercelSandboxFiles(sandbox, [
			{
				path: WRAPPER_PATH,
				content: wrapperSource,
				mode: 0o644,
			},
			{
				path: METADATA_PATH,
				content: JSON.stringify(
					{
						repairExecutionKey: context.repairExecutionKey,
						owner: input.owner,
						repository: input.repository,
						repositoryUrl: `https://github.com/${input.owner}/${input.repository}.git`,
						headRef: pullRequest.headRef,
						headSha: input.checkSummary.headSha,
						baseBranch: input.repositoryBaseBranch,
						repositoryPath: REPOSITORY_PATH,
						attemptCounts: context.attemptCounts,
						maxAttempts: context.maxAttempts,
						failureFingerprint: context.failureFingerprint,
						allowedChangedFiles,
						allowedChangedFilesSource,
					},
					null,
					2,
				),
				mode: 0o600,
			},
		]);

		const command = await deps.runVercelSandboxCommand(sandbox, {
			cmd: "node",
			args: [WRAPPER_PATH],
			cwd: SANDBOX_WORKDIR,
			env: {
				RHAPSODY_METADATA_PATH: METADATA_PATH,
			},
			timeoutMs: SANDBOX_TIMEOUT_MS - 10_000,
		});
		commandSummary = summarizeCommand(command);

		const wrapperOutput = parseWrapperOutput(command.stdout, command.stderr);
		if (!wrapperOutput.ok) {
			outcome = "repair_failed";
			commandError =
				wrapperOutput.error ??
				"repair wrapper did not emit valid repair outcome.";
		} else {
			outcome = wrapperOutput.outcome;
			commandArtifact = wrapperOutput.artifact ?? null;
			commandError = wrapperOutput.error ?? null;
		}
	} catch (error) {
		outcome = "repair_failed";
		commandError =
			error instanceof Error
				? error.message
				: "Unexpected repair execution failure.";
	} finally {
		if (sandbox) {
			await stopSandboxQuietly(sandbox, deps);
		}
	}

	const decisionId = await createDecision(input.client, {
		workItemId: input.workItemId,
		workerRunId: workerRun.id,
		phase: "repair",
		outcome,
		deterministic: true,
		policyRuleId: "format_fixable",
		nextWorkerKind: null,
		nextAction: buildRepairNextAction(outcome, commandError),
		evidence: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestNumber,
			pullRequestUrl: input.pullRequestUrl,
			classification: "format_fixable",
			checks: {
				headSha: input.checkSummary.headSha,
			},
			repairExecutionKey: context.repairExecutionKey,
			failureFingerprint: context.failureFingerprint,
			attemptCounts: context.attemptCounts,
			maxAttempts: context.maxAttempts,
			allowedChangedFiles,
			allowedChangedFilesSource,
			artifact: commandArtifact,
			command: commandSummary,
			error: commandError,
		},
	});

	await createLink(input.client, {
		workItemId: input.workItemId,
		fromNodeType: "worker_run",
		fromNodeId: workerRun.id,
		toNodeType: "decision",
		toNodeId: decisionId,
		relation: "decides",
		metadata: {
			outcome,
			repairExecutionKey: context.repairExecutionKey,
		},
	});

	await updateWorkerRunStatus(input.client, {
		id: workerRun.id,
		status: outcome === "repair_failed" ? "failed" : "completed",
	});

	if (outcome === "repair_applied" && commandArtifact) {
		const artifactId = await createArtifact(input.client, {
			workItemId: input.workItemId,
			workerRunId: workerRun.id,
			kind: "commit",
			externalId: commandArtifact.sha,
			externalUrl: commandArtifact.htmlUrl,
			snapshot: {
				changedFiles: commandArtifact.changedFiles,
			},
			metadata: {
				repairExecutionKey: context.repairExecutionKey,
				commandId: commandSummary?.commandId,
			},
		});

		return {
			executed: true,
			workerRunId: workerRun.id,
			decisionId,
			artifactId,
			outcome,
		};
	}

	return {
		executed: true,
		workerRunId: workerRun.id,
		decisionId,
		outcome,
	};
}

function parseWrapperOutput(
	stdout: string,
	stderr: string,
): {
	ok: boolean;
	outcome: RepairerExecutorOutcome;
	error?: string;
	artifact?: WrapperOutputArtifact;
} {
	const payload = pickJsonFromOutput(stdout) ?? pickJsonFromOutput(stderr);
	if (!payload) {
		return {
			ok: false,
			outcome: "repair_failed",
			error: "repair wrapper did not emit structured output",
		};
	}

	if (
		payload.outcome !== "repair_applied" &&
		payload.outcome !== "repair_noop" &&
		payload.outcome !== "repair_failed"
	) {
		return {
			ok: false,
			outcome: "repair_failed",
			error: "repair wrapper emitted invalid outcome",
		};
	}

	return {
		ok: payload.ok !== false,
		outcome: payload.outcome,
		error: typeof payload.error === "string" ? payload.error : undefined,
		artifact: normalizeArtifact(payload.artifact),
	};
}

function normalizeArtifact(value: unknown): WrapperOutputArtifact | undefined {
	if (!value || typeof value !== "object") {
		return undefined;
	}

	const artifact = value as {
		sha?: unknown;
		htmlUrl?: unknown;
		changedFiles?: unknown;
	};

	if (
		typeof artifact.sha === "string" &&
		typeof artifact.htmlUrl === "string" &&
		Array.isArray(artifact.changedFiles) &&
		artifact.changedFiles.every((item) => typeof item === "string")
	) {
		return {
			sha: artifact.sha,
			htmlUrl: artifact.htmlUrl,
			changedFiles: artifact.changedFiles,
		};
	}

	return undefined;
}

function pickJsonFromOutput(text: string) {
	const lines = text.trim().split("\n");
	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			const parsed = JSON.parse(lines[index].trim());
			if (
				parsed &&
				typeof parsed === "object" &&
				typeof parsed.outcome === "string"
			) {
				return parsed as WrapperOutput;
			}
		} catch {
			continue;
		}
	}

	return null;
}

function asRepairExecutionContext(
	inputPlan: RepairerPlan,
): RepairExecutionContext {
	return {
		repairExecutionKey: inputPlan.repairExecutionKey,
		failureFingerprint: inputPlan.failureFingerprint,
		attemptCounts: inputPlan.attemptCounts,
		maxAttempts: inputPlan.maxAttempts,
	};
}

function buildDependencies(input: Partial<DependencyBag> = {}): DependencyBag {
	return {
		getPullRequest,
		getPullRequestChangedFiles,
		createVercelSandbox,
		runVercelSandboxCommand,
		writeVercelSandboxFiles,
		stopVercelSandbox,
		...input,
	};
}

function getAllowedChangedFilesFromGraph(
	graph: WorkItemGraph,
	decisionId: string,
): string[] {
	const decision = graph.decisions.find((item) => item.id === decisionId);
	if (!decision) {
		return [];
	}

	const evidence = asRepairDecisionRecord(decision.evidence);
	const raw = evidence?.allowedChangedFiles;
	if (!Array.isArray(raw)) {
		return [];
	}

	return raw.filter((file): file is string => typeof file === "string");
}

function buildRepairNextAction(
	outcome: RepairerExecutorOutcome,
	errorMessage?: string | null,
) {
	if (outcome === "repair_applied") {
		return "Repairer applied a formatting-only fix and pushed the PR branch.";
	}
	if (outcome === "repair_noop") {
		return "Repairer observed no formatting changes were needed.";
	}
	return errorMessage
		? `Repairer failed to apply formatting: ${errorMessage}`
		: "Repairer failed to apply formatting.";
}

function hasActiveRepairerRun(
	graph: WorkItemGraph,
	repairExecutionKey: string,
) {
	return graph.workerRuns.some((run) => {
		if (
			run.kind !== "repairer" ||
			!["running", "pending"].includes(run.status)
		) {
			return false;
		}
		const metadata = asRepairDecisionRecord(run.metadata);
		return metadata?.repairExecutionKey === repairExecutionKey;
	});
}

function hasTerminalRepairOutcome(
	graph: WorkItemGraph,
	repairExecutionKey: string,
) {
	return graph.decisions.some((decision) => {
		if (decision.phase !== "repair") {
			return false;
		}
		if (!hasTerminalRepairDecisionOutcome(decision)) {
			return false;
		}
		const evidence = asRepairDecisionRecord(decision.evidence);
		return evidence?.repairExecutionKey === repairExecutionKey;
	});
}

function summarizeCommand(command: VercelSandboxCommandSummary): {
	commandId: string;
	cwd: string;
	exitCode: number;
	timedOut?: boolean;
	error?: string;
	stdout: string;
	stderr: string;
} {
	return {
		commandId: command.commandId,
		cwd: command.cwd,
		exitCode: command.exitCode,
		timedOut: command.timedOut,
		error: command.error,
		stdout: truncate(command.stdout, COMMAND_OUTPUT_PREVIEW_LENGTH),
		stderr: truncate(command.stderr, COMMAND_OUTPUT_PREVIEW_LENGTH),
	};
}

function truncate(text: string, maxLength: number) {
	return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function stopSandboxQuietly(
	sandbox: RhapsodyVercelSandbox,
	deps: DependencyBag,
) {
	return deps.stopVercelSandbox(sandbox).catch(() => undefined);
}
