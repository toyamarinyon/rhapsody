import path from "node:path";
import { readFile } from "node:fs/promises";
import type { Client } from "@libsql/client";
import { buildCodexChatGPTDummyAuthFile } from "@/lib/codex/auth";
import { buildCodexExecCommand } from "@/lib/codex/cli";
import { loadMediatorCredentialState } from "@/lib/codex/credentials";
import {
	loadRhapsodyGitHubEnv,
	loadRhapsodyMediatorEnv,
	loadRhapsodyProtectionBypassEnv,
} from "@/lib/config";
import type { PullRequestBranchComparison } from "@/lib/github/pull-requests";
import { loadRunnerCodexConfig } from "@/lib/runner-codex-config";
import {
	buildVercelSandboxCodexNetworkPolicy,
	buildVercelSandboxGitHubNetworkPolicy,
	createVercelSandbox,
	mergeNetworkPolicies,
	runVercelSandboxCommand,
	stopVercelSandbox,
	writeVercelSandboxFiles,
	type RhapsodyVercelSandbox,
	type VercelSandboxCommandSummary,
} from "@/lib/sandbox/vercel";
import {
	createArtifact,
	createDecision,
	createLink,
	createWorkerRun,
	listWorkItemGraph,
	updateWorkerRunStatus,
	type Decision,
	type WorkItemGraph,
} from "@/lib/state";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";

const SANDBOX_WORKDIR = "/vercel/sandbox";
const REPOSITORY_PATH = "/vercel/sandbox/repository";
const CODEX_HOME_PATH = `${SANDBOX_WORKDIR}/.codex`;
const WRAPPER_PATH = "integration-repair-wrapper.cjs";
const PROMPT_PATH = "integration-repair-prompt.txt";
const METADATA_PATH = "integration-repair-metadata.json";
const WRAPPER_SOURCE_PATH = path.join(
	process.cwd(),
	"lib",
	"workers",
	"integration-repair",
	"wrapper.cjs",
);
const SANDBOX_TIMEOUT_MS = 10 * 60 * 1000;
const CODEX_TIMEOUT_MS = 4 * 60 * 1000;
const COMMAND_OUTPUT_PREVIEW_LENGTH = 4000;
const DUMMY_CHATGPT_ACCOUNT_ID = "acct_dummy";

export type IntegrationRepairPlannerOutcome =
	| "integration_repair_needed"
	| "integration_repair_current";

export type IntegrationRepairExecutorOutcome =
	| "integration_repair_applied"
	| "integration_repair_conflict_resolved"
	| "integration_repair_conflict_unresolved"
	| "integration_repair_failed"
	| "integration_repair_noop";

export type IntegrationRepairPlannerResult = {
	workerRunId: string | null;
	decisionId: string;
	outcome: IntegrationRepairPlannerOutcome;
	skippedFreshDuplicate: boolean;
	integrationExecutionKey: string;
	headSha: string | null;
	baseSha: string | null;
	branchComparison: PullRequestBranchComparison;
};

export type IntegrationRepairExecutorResult = {
	executed: boolean;
	workerRunId?: string;
	decisionId?: string;
	artifactId?: string;
	outcome:
		| IntegrationRepairExecutorOutcome
		| "integration_repair_skipped_terminal"
		| "integration_repair_skipped_in_progress";
	terminalOutcome?: IntegrationRepairExecutorOutcome;
	reason?: string;
};

type IntegrationRepairPlan = Pick<
	IntegrationRepairPlannerResult,
	| "decisionId"
	| "integrationExecutionKey"
	| "headSha"
	| "baseSha"
	| "branchComparison"
>;

type WrapperOutputArtifact = {
	sha: string;
	htmlUrl: string;
	changedFiles: string[];
};

type WrapperOutput = {
	ok?: boolean;
	outcome: IntegrationRepairExecutorOutcome;
	error?: string;
	artifact?: WrapperOutputArtifact;
	conflictingFiles?: string[];
	remainingConflictingFiles?: string[];
	unexpectedChangedFiles?: string[];
	codex?: {
		exitCode: number | null;
		timedOut: boolean;
		stdoutPreview: string;
		stderrPreview: string;
		error?: string | null;
	};
};

type DependencyBag = {
	createVercelSandbox: typeof createVercelSandbox;
	runVercelSandboxCommand: typeof runVercelSandboxCommand;
	writeVercelSandboxFiles: typeof writeVercelSandboxFiles;
	stopVercelSandbox: typeof stopVercelSandbox;
	loadMediatorCredentialState: typeof loadMediatorCredentialState;
	loadRhapsodyGitHubEnv: typeof loadRhapsodyGitHubEnv;
	loadRhapsodyMediatorEnv: typeof loadRhapsodyMediatorEnv;
	loadRhapsodyProtectionBypassEnv: typeof loadRhapsodyProtectionBypassEnv;
	loadRunnerCodexConfig: typeof loadRunnerCodexConfig;
};

export type IntegrationRepairExecutorInput = {
	client: Client;
	workItem: GitHubProjectIssueWorkItem;
	workItemId: string;
	pullRequestNumber: number;
	pullRequestUrl: string;
	owner: string;
	repository: string;
	headRef: string;
	baseRef: string;
	plan: IntegrationRepairPlan;
	dependencies?: Partial<DependencyBag>;
};

const defaultDependencies: DependencyBag = {
	createVercelSandbox,
	runVercelSandboxCommand,
	writeVercelSandboxFiles,
	stopVercelSandbox,
	loadMediatorCredentialState,
	loadRhapsodyGitHubEnv,
	loadRhapsodyMediatorEnv,
	loadRhapsodyProtectionBypassEnv,
	loadRunnerCodexConfig,
};

export function buildIntegrationRepairExecutionKey(input: {
	pullRequestNumber: number;
	headSha: string | null;
	baseSha: string | null;
}) {
	return `${input.pullRequestNumber}:${input.headSha ?? "unknown"}:${input.baseSha ?? "unknown"}`;
}

export async function runIntegrationRepairPlanner(
	client: Client,
	input: {
		workItem: GitHubProjectIssueWorkItem;
		workItemId: string;
		postPrDecisionId: string;
		pullRequestNumber: number;
		pullRequestUrl: string;
		headSha: string | null;
		baseSha: string | null;
		branchComparison: PullRequestBranchComparison;
		existingDecisions: Decision[];
	},
): Promise<IntegrationRepairPlannerResult> {
	const integrationExecutionKey = buildIntegrationRepairExecutionKey({
		pullRequestNumber: input.pullRequestNumber,
		headSha: input.headSha,
		baseSha: input.baseSha,
	});
	const outcome: IntegrationRepairPlannerOutcome =
		input.branchComparison.status === "behind" ||
		(input.branchComparison.behindBy !== null &&
			input.branchComparison.behindBy > 0)
			? "integration_repair_needed"
			: "integration_repair_current";
	const freshDecision = findFreshIntegrationRepairDecision({
		decisions: input.existingDecisions,
		pullRequestNumber: input.pullRequestNumber,
		integrationExecutionKey,
		outcome,
	});

	if (freshDecision) {
		return {
			workerRunId: freshDecision.workerRunId,
			decisionId: freshDecision.id,
			outcome,
			skippedFreshDuplicate: true,
			integrationExecutionKey,
			headSha: input.headSha,
			baseSha: input.baseSha,
			branchComparison: input.branchComparison,
		};
	}

	const workerRun = await createWorkerRun(client, {
		workItemId: input.workItemId,
		kind: "integration_repairer",
		status: "completed",
		metadata: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestNumber,
			pullRequestUrl: input.pullRequestUrl,
			integrationExecutionKey,
			headSha: input.headSha,
			baseSha: input.baseSha,
			branchComparison: input.branchComparison,
		},
	});

	const decisionId = await createDecision(client, {
		workItemId: input.workItemId,
		workerRunId: workerRun.id,
		phase: "integration_repair",
		outcome,
		deterministic: true,
		policyRuleId: input.branchComparison.behindBy
			? "behind_base"
			: "branch_current",
		nextWorkerKind:
			outcome === "integration_repair_needed" ? "integration_repairer" : null,
		nextAction:
			outcome === "integration_repair_needed"
				? `Merge the latest ${input.branchComparison.base} into ${input.branchComparison.head} before CI repair.`
				: "Skip base integration because the pull request branch is already current with its base.",
		evidence: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestNumber,
			pullRequestUrl: input.pullRequestUrl,
			integrationExecutionKey,
			headSha: input.headSha,
			baseSha: input.baseSha,
			branchComparison: input.branchComparison,
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
				integrationExecutionKey,
				outcome,
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
				integrationExecutionKey,
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
		skippedFreshDuplicate: false,
		integrationExecutionKey,
		headSha: input.headSha,
		baseSha: input.baseSha,
		branchComparison: input.branchComparison,
	};
}

export async function runIntegrationRepairExecutor(
	input: IntegrationRepairExecutorInput,
): Promise<IntegrationRepairExecutorResult> {
	const deps = {
		...defaultDependencies,
		...input.dependencies,
	} as DependencyBag;
	const graph = await listWorkItemGraph(input.client, input.workItemId);

	const terminalDecision = findLatestTerminalIntegrationRepairDecision({
		decisions: graph.decisions,
		integrationExecutionKey: input.plan.integrationExecutionKey,
	});
	if (terminalDecision) {
		return {
			executed: false,
			decisionId: terminalDecision.id,
			outcome: "integration_repair_skipped_terminal",
			terminalOutcome:
				terminalDecision.outcome as IntegrationRepairExecutorOutcome,
			reason:
				"terminal integration repair outcome already recorded for this execution key",
		};
	}

	if (
		hasActiveIntegrationRepairRun({
			workerRuns: graph.workerRuns,
			integrationExecutionKey: input.plan.integrationExecutionKey,
		})
	) {
		return {
			executed: false,
			outcome: "integration_repair_skipped_in_progress",
			reason:
				"active integration repair run already exists for this execution key",
		};
	}

	const workerRun = await createWorkerRun(input.client, {
		workItemId: input.workItemId,
		kind: "integration_repairer",
		status: "running",
		metadata: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestNumber,
			pullRequestUrl: input.pullRequestUrl,
			integrationExecutionKey: input.plan.integrationExecutionKey,
			headSha: input.plan.headSha,
			baseSha: input.plan.baseSha,
			branchComparison: input.plan.branchComparison,
		},
	});

	await Promise.all([
		createLink(input.client, {
			workItemId: input.workItemId,
			fromNodeType: "decision",
			fromNodeId: input.plan.decisionId,
			toNodeType: "worker_run",
			toNodeId: workerRun.id,
			relation: "starts",
			metadata: {
				integrationExecutionKey: input.plan.integrationExecutionKey,
			},
		}),
		updateWorkerRunStatus(input.client, {
			id: workerRun.id,
			status: "running",
		}),
	]);

	let sandbox: RhapsodyVercelSandbox | null = null;
	let outcome: IntegrationRepairExecutorOutcome = "integration_repair_failed";
	let commandSummary: ReturnType<typeof summarizeCommand> | null = null;
	let commandArtifact: WrapperOutputArtifact | null = null;
	let commandError: string | null = null;
	let conflictingFiles: string[] = [];
	let remainingConflictingFiles: string[] = [];
	let unexpectedChangedFiles: string[] = [];
	let codexSummary: WrapperOutput["codex"] | null = null;

	try {
		const wrapperSource = await readFile(WRAPPER_SOURCE_PATH, "utf8");
		const prompt = buildIntegrationRepairPrompt({
			owner: input.owner,
			repository: input.repository,
			headRef: input.headRef,
			baseRef: input.baseRef,
		});
		let runnerCodexConfig: Awaited<ReturnType<typeof loadRunnerCodexConfig>>;
		try {
			runnerCodexConfig = await deps.loadRunnerCodexConfig();
		} catch {
			runnerCodexConfig = {
				config: null,
				loadedFromPath: ".rhapsody/config.toml",
			};
		}
		const codexCommand = buildCodexExecCommand({
			cwd: REPOSITORY_PATH,
			prompt,
			approvalPolicy: "never",
			json: true,
			skipGitRepoCheck: true,
			ephemeral: true,
			dangerouslyBypassApprovalsAndSandbox: true,
			timeoutMs: CODEX_TIMEOUT_MS,
			configOverrides: {
				model: runnerCodexConfig.config?.model ?? "gpt-5.4-mini",
				...(runnerCodexConfig.config?.reasoningEffort
					? { reasoning_effort: runnerCodexConfig.config.reasoningEffort }
					: {}),
			},
		});
		const origin = buildMediatorOrigin();
		const callbackUrl = new URL(
			"/api/internal/runs/callback",
			origin,
		).toString();
		const codexProxyUrl = new URL(
			`/api/internal/codex-chatgpt-proxy/runs/integration-repair/attempts/${encodeURIComponent(
				input.plan.integrationExecutionKey,
			)}`,
			origin,
		).toString();
		const mediatorEnv = deps.loadRhapsodyMediatorEnv();
		const protectionBypassEnv = deps.loadRhapsodyProtectionBypassEnv();
		const mediatorCredentialState = await deps.loadMediatorCredentialState();
		const authPayload = buildCodexChatGPTDummyAuthFile(
			mediatorCredentialState?.accountId ?? DUMMY_CHATGPT_ACCOUNT_ID,
		);

		sandbox = await deps.createVercelSandbox({
			timeout: SANDBOX_TIMEOUT_MS,
			networkPolicy: mergeNetworkPolicies(
				buildVercelSandboxGitHubNetworkPolicy({
					githubToken: deps.loadRhapsodyGitHubEnv().GITHUB_TOKEN,
					authorizationHeaderPrefix: "basic",
				}),
				buildVercelSandboxCodexNetworkPolicy({
					callbackUrl,
					mediatorSecret: mediatorEnv.MEDIATOR_SECRET,
					codexProxyUrl,
					vercelProtectionBypassSecret:
						protectionBypassEnv.VERCEL_PROTECTION_BYPASS_SECRET,
					proxyChatGPTAccountApi: false,
				}),
			),
		});

		await deps.writeVercelSandboxFiles(sandbox, [
			{
				path: WRAPPER_PATH,
				content: wrapperSource,
				mode: 0o644,
			},
			{
				path: PROMPT_PATH,
				content: prompt,
				mode: 0o600,
			},
			{
				path: METADATA_PATH,
				content: JSON.stringify(
					{
						owner: input.owner,
						repository: input.repository,
						repositoryUrl: `https://github.com/${input.owner}/${input.repository}.git`,
						repositoryPath: REPOSITORY_PATH,
						headRef: input.headRef,
						baseRef: input.baseRef,
						commitMessage: `chore: integrate latest ${input.baseRef} into ${input.headRef}`,
						integrationExecutionKey: input.plan.integrationExecutionKey,
						codexTimeoutMs: CODEX_TIMEOUT_MS,
						codexCommand: {
							command: codexCommand.command,
							argv: codexCommand.argv,
							cwd: codexCommand.cwd,
						},
						gitUserName: "Rhapsody Codex",
						gitUserEmail: "rhapsody-codex@localhost",
					},
					null,
					2,
				),
				mode: 0o600,
			},
			{
				path: `${CODEX_HOME_PATH}/auth.json`,
				content: JSON.stringify(authPayload, null, 2),
				mode: 0o600,
			},
		]);

		const command = await deps.runVercelSandboxCommand(sandbox, {
			cmd: "node",
			args: [WRAPPER_PATH],
			cwd: SANDBOX_WORKDIR,
			env: {
				CODEX_HOME: CODEX_HOME_PATH,
				RHAPSODY_METADATA_PATH: METADATA_PATH,
				RHAPSODY_PROMPT_PATH: PROMPT_PATH,
			},
			timeoutMs: SANDBOX_TIMEOUT_MS - 10_000,
		});
		commandSummary = summarizeCommand(command);
		const wrapperOutput = parseWrapperOutput(command.stdout, command.stderr);
		if (!wrapperOutput.valid) {
			outcome = "integration_repair_failed";
			commandError =
				wrapperOutput.error ??
				"integration repair wrapper did not emit valid structured output";
		} else {
			outcome = wrapperOutput.outcome;
			commandArtifact = wrapperOutput.artifact ?? null;
			commandError = wrapperOutput.error ?? null;
			conflictingFiles = wrapperOutput.conflictingFiles ?? [];
			remainingConflictingFiles = wrapperOutput.remainingConflictingFiles ?? [];
			unexpectedChangedFiles = wrapperOutput.unexpectedChangedFiles ?? [];
			codexSummary = wrapperOutput.codex ?? null;
		}
	} catch (error) {
		outcome = "integration_repair_failed";
		commandError =
			error instanceof Error
				? error.message
				: "Unexpected integration repair execution failure.";
	} finally {
		if (sandbox) {
			await stopSandboxQuietly(sandbox, deps);
		}
	}

	const decisionId = await createDecision(input.client, {
		workItemId: input.workItemId,
		workerRunId: workerRun.id,
		phase: "integration_repair",
		outcome,
		deterministic: true,
		policyRuleId: "behind_base",
		nextWorkerKind: null,
		nextAction: buildIntegrationRepairNextAction(outcome, commandError),
		evidence: {
			issueNumber: input.workItem.issueNumber,
			pullRequestNumber: input.pullRequestNumber,
			pullRequestUrl: input.pullRequestUrl,
			integrationExecutionKey: input.plan.integrationExecutionKey,
			headSha: input.plan.headSha,
			baseSha: input.plan.baseSha,
			branchComparison: input.plan.branchComparison,
			artifact: commandArtifact,
			command: commandSummary,
			error: commandError,
			conflictingFiles,
			remainingConflictingFiles,
			unexpectedChangedFiles,
			codex: codexSummary,
		},
	});

	await Promise.all([
		createLink(input.client, {
			workItemId: input.workItemId,
			fromNodeType: "worker_run",
			fromNodeId: workerRun.id,
			toNodeType: "decision",
			toNodeId: decisionId,
			relation: "decides",
			metadata: {
				outcome,
				integrationExecutionKey: input.plan.integrationExecutionKey,
			},
		}),
		updateWorkerRunStatus(input.client, {
			id: workerRun.id,
			status:
				outcome === "integration_repair_failed" ||
				outcome === "integration_repair_conflict_unresolved"
					? "failed"
					: "completed",
		}),
	]);

	if (
		(outcome === "integration_repair_applied" ||
			outcome === "integration_repair_conflict_resolved") &&
		commandArtifact
	) {
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
				integrationExecutionKey: input.plan.integrationExecutionKey,
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
		reason: commandError ?? undefined,
	};
}

function buildIntegrationRepairPrompt(input: {
	owner: string;
	repository: string;
	headRef: string;
	baseRef: string;
}) {
	return [
		`Repository: ${input.owner}/${input.repository}.`,
		`A git merge of origin/${input.baseRef} into ${input.headRef} has already been attempted in the current checkout.`,
		"Resolve only the current merge conflicts while preserving the pull request intent and incorporating the latest base branch changes.",
		"Do not run git commit or git push.",
		"Do not modify unrelated files.",
		"When you are done, leave the repository with no unmerged paths.",
	].join("\n");
}

function buildIntegrationRepairNextAction(
	outcome: IntegrationRepairExecutorOutcome,
	error: string | null,
) {
	switch (outcome) {
		case "integration_repair_applied":
			return "Re-observe checks on the new pull request head after clean base integration.";
		case "integration_repair_conflict_resolved":
			return "Re-observe checks on the new pull request head after conflict resolution.";
		case "integration_repair_noop":
			return "Continue post-PR evaluation because base integration made no new change.";
		case "integration_repair_conflict_unresolved":
			return "Escalate to Human Review because the conflict-resolution agent could not produce a safe merge.";
		default:
			return error
				? `Escalate because integration repair failed: ${error}`
				: "Escalate because integration repair failed.";
	}
}

function findFreshIntegrationRepairDecision(input: {
	decisions: Decision[];
	pullRequestNumber: number;
	integrationExecutionKey: string;
	outcome: IntegrationRepairPlannerOutcome;
}) {
	return (
		input.decisions.find((decision) => {
			if (
				decision.phase !== "integration_repair" ||
				decision.outcome !== input.outcome
			) {
				return false;
			}

			const evidence = asRecord(decision.evidence);
			return (
				evidence?.pullRequestNumber === input.pullRequestNumber &&
				evidence?.integrationExecutionKey === input.integrationExecutionKey
			);
		}) ?? null
	);
}

function findLatestTerminalIntegrationRepairDecision(input: {
	decisions: Decision[];
	integrationExecutionKey: string;
}) {
	const candidates = input.decisions.filter((decision) => {
		if (
			decision.phase !== "integration_repair" ||
			!isTerminalIntegrationRepairOutcome(decision.outcome)
		) {
			return false;
		}

		const evidence = asRecord(decision.evidence);
		return evidence?.integrationExecutionKey === input.integrationExecutionKey;
	});

	if (candidates.length === 0) {
		return null;
	}

	return candidates.sort((left, right) => right.createdAt - left.createdAt)[0];
}

function isTerminalIntegrationRepairOutcome(
	outcome: string,
): outcome is IntegrationRepairExecutorOutcome {
	return (
		outcome === "integration_repair_applied" ||
		outcome === "integration_repair_conflict_resolved" ||
		outcome === "integration_repair_conflict_unresolved" ||
		outcome === "integration_repair_failed" ||
		outcome === "integration_repair_noop"
	);
}

function hasActiveIntegrationRepairRun(input: {
	workerRuns: WorkItemGraph["workerRuns"];
	integrationExecutionKey: string;
}) {
	return input.workerRuns.some((run) => {
		if (run.kind !== "integration_repairer") {
			return false;
		}
		if (!["pending", "running"].includes(run.status)) {
			return false;
		}

		const metadata = asRecord(run.metadata);
		return metadata?.integrationExecutionKey === input.integrationExecutionKey;
	});
}

function parseWrapperOutput(
	stdout: string,
	stderr: string,
): WrapperOutput & { valid: boolean } {
	const payload = pickJsonFromOutput(stdout) ?? pickJsonFromOutput(stderr);
	if (!payload) {
		return {
			valid: false,
			outcome: "integration_repair_failed",
			error: "integration repair wrapper did not emit structured output",
		};
	}

	if (
		payload.outcome !== "integration_repair_applied" &&
		payload.outcome !== "integration_repair_conflict_resolved" &&
		payload.outcome !== "integration_repair_conflict_unresolved" &&
		payload.outcome !== "integration_repair_failed" &&
		payload.outcome !== "integration_repair_noop"
	) {
		return {
			valid: false,
			outcome: "integration_repair_failed",
			error: "integration repair wrapper emitted an unknown outcome",
		};
	}

	return {
		valid: true,
		outcome: payload.outcome,
		error: typeof payload.error === "string" ? payload.error : undefined,
		artifact: isWrapperOutputArtifact(payload.artifact)
			? payload.artifact
			: undefined,
		conflictingFiles: toStringArray(payload.conflictingFiles),
		remainingConflictingFiles: toStringArray(payload.remainingConflictingFiles),
		unexpectedChangedFiles: toStringArray(payload.unexpectedChangedFiles),
		codex: asCodexSummary(payload.codex),
	};
}

function pickJsonFromOutput(text: string) {
	const lines = text
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("{") && line.endsWith("}"));

	for (let index = lines.length - 1; index >= 0; index -= 1) {
		try {
			const parsed = JSON.parse(lines[index] ?? "");
			if (parsed && typeof parsed === "object") {
				return parsed as Record<string, unknown>;
			}
		} catch {
			// ignore malformed lines
		}
	}

	return null;
}

function isWrapperOutputArtifact(
	value: unknown,
): value is WrapperOutputArtifact {
	const record = asRecord(value);
	return Boolean(
		record &&
			typeof record.sha === "string" &&
			typeof record.htmlUrl === "string" &&
			Array.isArray(record.changedFiles) &&
			record.changedFiles.every((candidate) => typeof candidate === "string"),
	);
}

function asCodexSummary(value: unknown): WrapperOutput["codex"] | undefined {
	const record = asRecord(value);
	if (!record) {
		return undefined;
	}

	if (typeof record.exitCode !== "number" && record.exitCode !== null) {
		return undefined;
	}

	if (
		typeof record.timedOut !== "boolean" ||
		typeof record.stdoutPreview !== "string" ||
		typeof record.stderrPreview !== "string"
	) {
		return undefined;
	}

	return {
		exitCode: record.exitCode,
		timedOut: record.timedOut,
		stdoutPreview: record.stdoutPreview,
		stderrPreview: record.stderrPreview,
		error: typeof record.error === "string" ? record.error : null,
	};
}

function toStringArray(value: unknown) {
	return Array.isArray(value)
		? value.filter(
				(candidate): candidate is string => typeof candidate === "string",
			)
		: [];
}

function summarizeCommand(command: VercelSandboxCommandSummary) {
	return {
		commandId: command.commandId,
		cwd: command.cwd,
		startedAt: command.startedAt,
		exitCode: command.exitCode,
		timedOut: Boolean(command.timedOut),
		error: typeof command.error === "string" ? command.error : undefined,
		stdoutPreview: command.stdout.slice(0, COMMAND_OUTPUT_PREVIEW_LENGTH),
		stderrPreview: command.stderr.slice(0, COMMAND_OUTPUT_PREVIEW_LENGTH),
	};
}

async function stopSandboxQuietly(
	sandbox: RhapsodyVercelSandbox,
	deps: DependencyBag,
) {
	try {
		await deps.stopVercelSandbox(sandbox);
	} catch {
		// best-effort cleanup
	}
}

function buildMediatorOrigin() {
	const raw =
		process.env.VERCEL_URL ||
		process.env.RHAPSODY_ORIGIN ||
		"http://localhost:3000";

	if (raw.startsWith("http://") || raw.startsWith("https://")) {
		return raw;
	}

	return `https://${raw}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}
