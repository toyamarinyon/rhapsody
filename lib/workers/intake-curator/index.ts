import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Client } from "@libsql/client";
import { z } from "zod";
import { buildCodexExecCommand, runCodexExec } from "@/lib/codex/cli";
import {
	createIssueComment,
	fetchIssueComments,
	fetchIssueDependenciesBlockedBy,
	type GitHubBlockedByDependency,
	type GitHubIssueComment,
} from "@/lib/github/issues";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";
import {
	createArtifact,
	createDecision,
	createLink,
	createWorkerRun,
	type Decision,
	listWorkItemGraph,
	updateWorkerRunStatus,
	type WorkItemGraph,
} from "@/lib/state";

export type IntakeBlockerState = "open" | "closed" | "unknown";

export type IntakeBlockerInput = {
	id: string;
	state?: IntakeBlockerState | string;
};

export type IntakeCuratorWorkItem = Omit<
	GitHubProjectIssueWorkItem,
	"blockedBy"
> & {
	blockedBy?: Array<string | IntakeBlockerInput>;
	projectMetadata?: Record<string, unknown>;
};

type IntakeResolvedBlocker = {
	id: string;
	state: IntakeBlockerState;
	dependencyNumber?: number;
	dependencyRepository?: string;
	dependencyTitle?: string;
	dependencyHtmlUrl?: string;
};

export type IntakeCuratorOutcome =
	| "buildable"
	| "ask_human"
	| "skip"
	| "blocked";

type IntakeWorkerClassification =
	| IntakeClassification
	| {
			decision: "blocked";
			summary: string;
			reason: string;
			comment: string;
			next_action?: string;
	  };

const buildableSchema = z
	.object({
		decision: z.literal("buildable"),
		summary: z.string().min(1).max(1200),
		implementation_plan: z.string().min(1).max(4000),
		comment: z.string().min(1),
		next_action: z.string().optional(),
	})
	.strict();

const askHumanSchema = z
	.object({
		decision: z.literal("ask_human"),
		summary: z.string().min(1).max(1200),
		question: z.string().min(1).max(2000),
		comment: z.string().min(1),
		next_action: z.string().optional(),
	})
	.strict();

const skipSchema = z
	.object({
		decision: z.literal("skip"),
		summary: z.string().min(1).max(1200),
		reason: z.string().min(1),
		comment: z.string().min(1),
		next_action: z.string().optional(),
	})
	.strict();

export const intakeClassificationSchema = z.discriminatedUnion("decision", [
	buildableSchema,
	askHumanSchema,
	skipSchema,
]);

export const intakeClassificationJsonSchema = {
	$schema: "https://json-schema.org/draft/2020-12/schema",
	$title: "IntakeClassification",
	title: "IntakeClassification",
	oneOf: [
		{
			type: "object",
			additionalProperties: false,
			required: ["decision", "summary", "implementation_plan", "comment"],
			properties: {
				decision: { enum: ["buildable"] },
				summary: { type: "string", minLength: 1, maxLength: 1200 },
				implementation_plan: { type: "string", minLength: 1, maxLength: 4000 },
				comment: { type: "string", minLength: 1 },
				next_action: { type: "string" },
			},
		},
		{
			type: "object",
			additionalProperties: false,
			required: ["decision", "summary", "question", "comment"],
			properties: {
				decision: { enum: ["ask_human"] },
				summary: { type: "string", minLength: 1, maxLength: 1200 },
				question: { type: "string", minLength: 1, maxLength: 2000 },
				comment: { type: "string", minLength: 1 },
				next_action: { type: "string" },
			},
		},
		{
			type: "object",
			additionalProperties: false,
			required: ["decision", "summary", "reason", "comment"],
			properties: {
				decision: { enum: ["skip"] },
				summary: { type: "string", minLength: 1, maxLength: 1200 },
				reason: { type: "string", minLength: 1 },
				comment: { type: "string", minLength: 1 },
				next_action: { type: "string" },
			},
		},
	],
};

export type IntakeClassification = z.infer<typeof intakeClassificationSchema>;

export type IntakeCuratorResult = {
	decisionId: string;
	workerRunId: string | null;
	outcome: IntakeCuratorOutcome;
	nextAction?: string;
	shouldStartBuilder: boolean;
	skippedFreshDuplicate: boolean;
	inputFingerprint: string;
	commentPosted: boolean;
	classificationReason: string;
};

export type IntakeClassifierRunner = (input: {
	prompt: string;
	schemaFilePath: string;
	outputMessagePath: string;
	workItem: IntakeCuratorWorkItem;
	attempt: number;
}) => Promise<{
	classification: IntakeClassification;
	raw: string;
	command: string;
}>;

export type IntakeClassifierOutputFailureMetadata = {
	rawOutput: {
		available: boolean;
		preview?: string;
	};
	command?: string;
	runner?: {
		exitCode: number | null;
		signal: string | null;
		timedOut: boolean;
		durationMs: number;
		stdoutPreview?: string;
		stderrPreview?: string;
		error?: string;
	};
};

export class IntakeClassifierOutputError extends Error {
	readonly errorMetadata: IntakeClassifierOutputFailureMetadata;
	readonly outputStage: IntakeClassifierAttemptCategory;
	constructor(
		message: string,
		errorMetadata: IntakeClassifierOutputFailureMetadata,
		outputStage: IntakeClassifierAttemptCategory,
	) {
		super(message);
		this.name = "IntakeClassifierOutputError";
		this.errorMetadata = errorMetadata;
		this.outputStage = outputStage;
	}
}

type IntakeClassifierAttemptCategory =
	| "runner_error"
	| "parse_error"
	| "schema_error"
	| "validation_error"
	| "unknown_error";

type IntakeClassifierAttemptDiagnostic = {
	attempt: number;
	stage: IntakeClassifierAttemptCategory;
	errorMessage: string;
	rawOutput: {
		available: boolean;
		preview?: string;
	};
	runner?: {
		exitCode: number | null;
		signal: string | null;
		timedOut: boolean;
		durationMs: number;
		stdoutPreview?: string;
		stderrPreview?: string;
		error?: string;
	};
	command?: string;
};

type IntakeClassifierDiagnostics = {
	fallbackUsed: boolean;
	failedAttempts: IntakeClassifierAttemptDiagnostic[];
};

type IntakeClassifierHealingResult = {
	classification: IntakeClassification;
	diagnostics: IntakeClassifierDiagnostics;
};

export type IntakeBlockedByDependencyFetcher = (input: {
	owner: string;
	repository: string;
	issueNumber: number;
}) => Promise<GitHubBlockedByDependency[]>;

export type IssueCommenter = (input: {
	owner: string;
	repository: string;
	issueNumber: number;
	body: string;
}) => Promise<{ id: number; htmlUrl: string }>;

type IntakeIssueCommentFetcher = (input: {
	owner: string;
	repository: string;
	issueNumber: number;
}) => Promise<GitHubIssueComment[]>;

export type IntakeCuratorOptions = {
	existingDecisions?: Decision[];
	classify?: IntakeClassifierRunner;
	nowMs?: number;
	comment?: IssueCommenter;
	schemaFilePath?: string;
	dependencies?: {
		fetchBlockedBy?: IntakeBlockedByDependencyFetcher;
		fetchIssueComments?: IntakeIssueCommentFetcher;
	};
};

const DEFAULT_CLASSIFIER_MODEL = "gpt-5.4-mini";
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 120_000;

export async function runIntakeCurator(
	client: Client,
	workItem: IntakeCuratorWorkItem,
	workItemId: string,
	options: IntakeCuratorOptions = {},
): Promise<IntakeCuratorResult> {
	const resolvedBlockers = await resolveBlockersForItem({
		workItem,
		fetchBlockedBy: options.dependencies?.fetchBlockedBy,
	});
	const workItemGraph = await safeListWorkItemGraph(client, workItemId);
	const humanReplies = await getHumanRepliesForWorkItem({
		workItem,
		artifacts: workItemGraph.artifacts,
		fetcher: options.dependencies?.fetchIssueComments ?? fetchIssueComments,
	});
	const inputFingerprint = buildIntakeInputFingerprint(
		workItem,
		resolvedBlockers.blockers,
		humanReplies,
	);
	const deterministic = inferDeterministicClassificationFromResolved(
		resolvedBlockers.blockers,
	);
	const freshDecision = findFreshIntakeDecision({
		decisions: options.existingDecisions ?? [],
		inputFingerprint,
	});

	if (freshDecision) {
		const evidence = asRecord(freshDecision.evidence);
		const outcome = normalizeOutcome(freshDecision.outcome);
		return {
			decisionId: freshDecision.id,
			workerRunId: null,
			outcome,
			nextAction:
				typeof evidence?.nextAction === "string"
					? evidence.nextAction
					: undefined,
			shouldStartBuilder: outcome === "buildable",
			skippedFreshDuplicate: true,
			inputFingerprint,
			commentPosted: false,
			classificationReason:
				typeof evidence?.reason === "string"
					? evidence.reason
					: "No-op: reused intake decision.",
		};
	}

	let finalClassification: IntakeWorkerClassification;
	let classifierDiagnostics: IntakeClassifierDiagnostics | null = null;

	if (deterministic) {
		finalClassification = deterministic;
	} else if (resolvedBlockers.requiresHumanFallback) {
		finalClassification = {
			decision: "ask_human",
			summary: "Rhapsody could not verify issue dependencies from GitHub.",
			question:
				"Please confirm dependency relationships in the issue so we can safely proceed.",
			comment:
				"Dependency resolution failed; confirm blockers and issue linkage before continuing.",
			next_action: "confirm_dependency_relationships",
		};
	} else {
		const healingResult = await classifyWithHealing(
			workItem,
			resolvedBlockers.blockers,
			humanReplies,
			{
				runner: options.classify ?? runCodexIntakeClassification,
				schemaFilePath: options.schemaFilePath,
				nowMs: options.nowMs,
			},
		);
		finalClassification = healingResult.classification;
		classifierDiagnostics = healingResult.diagnostics;
	}

	const workerRun = await createWorkerRun(client, {
		workItemId,
		kind: "intake_curator",
		status: "completed",
		metadata: {
			issueNumber: workItem.issueNumber,
			issueTitle: workItem.issueTitle,
		},
	});

	const decisionEvidence: {
		inputFingerprint: string;
		issueTitle: string;
		issueNumber: number;
		projectStatus: string | null;
		blockedBy: IntakeResolvedBlocker[];
		blockerSource: "native" | "project_text" | "none";
		requiresHumanDependencyConfirmation: boolean;
		projectMetadata: Record<string, unknown> | null;
		summary: string;
		reason: string;
		nextAction: string | null;
		comment: string | null;
		humanReplies: Array<{
			id: number;
			updatedAt: string;
			body: string | null;
		}>;
		policyRuleId: string | null;
		classifierDiagnostics?: IntakeClassifierDiagnostics;
	} = {
		inputFingerprint,
		issueTitle: workItem.issueTitle,
		issueNumber: workItem.issueNumber,
		projectStatus: workItem.projectStatus ?? null,
		blockedBy: resolvedBlockers.blockers,
		blockerSource: resolvedBlockers.source,
		requiresHumanDependencyConfirmation: resolvedBlockers.requiresHumanFallback,
		projectMetadata: workItem.projectMetadata ?? null,
		summary: finalClassification.summary,
		reason: getClassificationReason(finalClassification),
		nextAction: pickNextAction(finalClassification),
		comment: finalClassification.comment ?? null,
		humanReplies: humanReplies.map((reply) => ({
			id: reply.id,
			updatedAt: reply.updatedAt,
			body: reply.body,
		})),
		policyRuleId: computePolicyRuleId(
			finalClassification.decision,
			deterministic,
		),
	};

	if (classifierDiagnostics) {
		decisionEvidence.classifierDiagnostics = classifierDiagnostics;
	}

	const decisionId = await createDecision(client, {
		workItemId,
		workerRunId: workerRun.id,
		phase: "intake",
		deterministic: deterministic !== null,
		policyVersion: "v1",
		policyRuleId: decisionEvidence.policyRuleId,
		outcome: finalClassification.decision,
		nextWorkerKind:
			finalClassification.decision === "buildable" ? "builder" : null,
		evidence: decisionEvidence,
		nextAction: decisionEvidence.nextAction ?? undefined,
	});

	await updateWorkerRunStatus(client, {
		id: workerRun.id,
		status: "completed",
	});

	let commentPosted = false;
	if (
		finalClassification.comment.trim() &&
		!(await hasExistingIntakeCommentForFingerprint({
			client,
			workItemId,
			inputFingerprint,
		}))
	) {
		commentPosted = await postIntakeComment({
			client,
			workItem,
			workerRunId: workerRun.id,
			workItemId,
			classification: finalClassification,
			resolvedBlockers: resolvedBlockers.blockers,
			commenter: options.comment ?? createIssueComment,
			inputFingerprint,
		});
	}

	return {
		decisionId,
		workerRunId: workerRun.id,
		outcome: finalClassification.decision,
		nextAction: decisionEvidence.nextAction ?? undefined,
		shouldStartBuilder: finalClassification.decision === "buildable",
		skippedFreshDuplicate: false,
		inputFingerprint,
		commentPosted,
		classificationReason: getClassificationReason(finalClassification),
	};
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

export function isIntakeBuildable(item: {
	issueTitle: string;
	issueBody: string | null;
}): boolean {
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

export function buildIntakeInputFingerprint(
	workItem: IntakeCuratorWorkItem,
	resolvedBlockers?: IntakeResolvedBlocker[],
	humanReplies?: GitHubIssueComment[],
): string {
	const normalized = {
		issueTitle: (workItem.issueTitle ?? "").trim(),
		issueBody: (workItem.issueBody ?? "").trim(),
		issueNumber: workItem.issueNumber,
		blockedBy: resolvedBlockers ?? normalizeBlockedBy(workItem.blockedBy),
		projectStatus: workItem.projectStatus ?? null,
		humanReplies: (humanReplies ?? []).map((reply) => ({
			id: reply.id,
			updatedAt: reply.updatedAt,
		})),
	};

	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function classifyWithHealing(
	workItem: IntakeCuratorWorkItem,
	blockedBy: IntakeResolvedBlocker[],
	humanReplies: GitHubIssueComment[],
	options: {
		runner: IntakeClassifierRunner;
		nowMs?: number;
		schemaFilePath?: string;
	},
): Promise<IntakeClassifierHealingResult> {
	const failedAttempts: IntakeClassifierAttemptDiagnostic[] = [];

	for (let attempt = 1; attempt <= 2; attempt += 1) {
		let raw: string | undefined;
		let command: string | undefined;
		try {
			const prompt = buildIntakeClassificationPrompt(
				workItem,
				blockedBy,
				humanReplies,
			);
			const schemaFilePath = await ensureSchemaFile(options.schemaFilePath);
			const outputMessagePath = buildOutputMessagePath(options.nowMs, attempt);
			const result = await options.runner({
				prompt,
				schemaFilePath,
				outputMessagePath,
				workItem,
				attempt,
			});
			raw = result.raw;
			command = result.command;
			const classification = intakeClassificationSchema.parse(
				result.classification,
			);
			return {
				classification,
				diagnostics: {
					fallbackUsed: false,
					failedAttempts,
				},
			};
		} catch (error) {
			const message = errorMessage(error);
			const normalizedMessage = message.toLowerCase();
			const metadata =
				error instanceof IntakeClassifierOutputError
					? error.errorMetadata
					: null;
			const rawOutputFromMetadata = metadata?.rawOutput;
			const outputPreviewFromError = metadata?.rawOutput.preview;
			const runnerMetadata = metadata?.runner
				? {
						...metadata.runner,
						stdoutPreview:
							typeof metadata.runner.stdoutPreview === "string"
								? boundedRedactedOutputPreview(metadata.runner.stdoutPreview)
								: undefined,
						stderrPreview:
							typeof metadata.runner.stderrPreview === "string"
								? boundedRedactedOutputPreview(metadata.runner.stderrPreview)
								: undefined,
						error:
							typeof metadata.runner.error === "string"
								? boundedRedactedOutputPreview(metadata.runner.error, 320)
								: undefined,
					}
				: undefined;
			const boundedMetadataPreview = outputPreviewFromError
				? boundedErrorMessage(outputPreviewFromError, 320)
				: undefined;
			const commandFromError =
				metadata?.command ?? (command ? command : undefined);
			let stage: IntakeClassifierAttemptCategory = "runner_error";
			if (error instanceof IntakeClassifierOutputError) {
				stage = error.outputStage;
			} else if (error instanceof z.ZodError) {
				stage = "schema_error";
			} else if (
				normalizedMessage.includes("validation") ||
				normalizedMessage.includes("invalid")
			) {
				stage = "validation_error";
			} else if (
				normalizedMessage.includes("parse") ||
				normalizedMessage.includes("parseable")
			) {
				stage = "parse_error";
			}

			failedAttempts.push({
				attempt,
				stage,
				errorMessage: boundedErrorMessage(message),
				runner: runnerMetadata,
				rawOutput: {
					available: rawOutputFromMetadata
						? rawOutputFromMetadata.available
						: Boolean(raw),
					preview:
						boundedMetadataPreview ??
						(raw ? safeTextPreview(raw, 320) : undefined),
				},
				command:
					commandFromError && isSafeCommand(commandFromError)
						? commandFromError
						: undefined,
			});
		}
	}

	return {
		classification: {
			decision: "ask_human",
			summary: "Rhapsody could not safely classify this issue automatically.",
			question:
				"Could you clarify the expected change and acceptance criteria before Rhapsody starts implementation?",
			comment:
				"Please clarify remaining scope and constraints so Rhapsody can proceed safely.",
			next_action: "add_context_and_acceptance_criteria",
		},
		diagnostics: {
			fallbackUsed: true,
			failedAttempts,
		},
	};
}

async function runCodexIntakeClassification(
	input: Parameters<IntakeClassifierRunner>[0],
): Promise<{
	classification: IntakeClassification;
	raw: string;
	command: string;
}> {
	const outputMessagePath = input.outputMessagePath;
	const options = {
		cwd: process.cwd(),
		prompt: input.prompt,
		approvalPolicy: "never" as const,
		sandboxMode: "workspace-write" as const,
		json: true,
		skipGitRepoCheck: true,
		outputSchemaFile: input.schemaFilePath,
		outputLastMessageFile: outputMessagePath,
		timeoutMs: DEFAULT_CLASSIFIER_TIMEOUT_MS,
		configOverrides: {
			model: DEFAULT_CLASSIFIER_MODEL,
		},
	};
	const command = buildCodexExecCommand(options);
	const result = await runCodexExec(options);

	if (result.exitCode !== 0 || result.timedOut || result.error) {
		throw new IntakeClassifierOutputError(
			`Codex intake classification failed (code=${result.exitCode}, timedOut=${result.timedOut}).`,
			{
				rawOutput: {
					available: false,
				},
				command: command.argv.join(" "),
				runner: {
					exitCode: result.exitCode,
					signal: result.signal ? String(result.signal) : null,
					timedOut: result.timedOut,
					durationMs: result.durationMs,
					stdoutPreview: boundedRedactedOutputPreview(result.stdout),
					stderrPreview: boundedRedactedOutputPreview(result.stderr),
					error:
						typeof result.error === "string"
							? boundedErrorMessage(result.error, 500)
							: undefined,
				},
			},
			"runner_error",
		);
	}

	const raw = await readFile(outputMessagePath, "utf8");
	let parsed: IntakeClassification;
	try {
		parsed = parseClassifierOutput(raw);
	} catch (error) {
		if (error instanceof z.ZodError) {
			throw new IntakeClassifierOutputError(
				"Classifier output did not match expected intake schema.",
				{
					rawOutput: {
						available: true,
						preview: safeTextPreview(raw, 320),
					},
					command: command.argv.join(" "),
				},
				"schema_error",
			);
		}

		throw new IntakeClassifierOutputError(
			error instanceof Error
				? error.message
				: "Classifier output could not be parsed.",
			{
				rawOutput: {
					available: true,
					preview: safeTextPreview(raw, 320),
				},
				command: command.argv.join(" "),
			},
			"parse_error",
		);
	}

	return {
		classification: parsed,
		raw,
		command: command.argv.join(" "),
	};
}

type BlockerResolutionResult = {
	source: "native" | "project_text" | "none";
	blockers: IntakeResolvedBlocker[];
	requiresHumanFallback: boolean;
};

async function resolveBlockersForItem(input: {
	workItem: IntakeCuratorWorkItem;
	fetchBlockedBy?: IntakeBlockedByDependencyFetcher;
}): Promise<BlockerResolutionResult> {
	const fetcher =
		input.fetchBlockedBy ??
		((args) =>
			fetchIssueDependenciesBlockedBy({
				owner: args.owner,
				repository: args.repository,
				issueNumber: args.issueNumber,
			}));

	const projectBlockedBy = normalizeBlockedBy(input.workItem.blockedBy);
	try {
		const dependencies = await fetcher({
			owner: input.workItem.repository.owner,
			repository: input.workItem.repository.name,
			issueNumber: input.workItem.issueNumber,
		});

		const blockers = dependencies.map((dependency) =>
			normalizeBlockedByDependency(dependency, input.workItem.repository),
		);

		return {
			source: "native",
			blockers,
			requiresHumanFallback: false,
		};
	} catch {
		if (projectBlockedBy.length > 0) {
			return {
				source: "project_text",
				blockers: projectBlockedBy,
				requiresHumanFallback: false,
			};
		}

		return {
			source: "none",
			blockers: [],
			requiresHumanFallback: true,
		};
	}
}

function inferDeterministicClassificationFromResolved(
	blockers: IntakeResolvedBlocker[],
): IntakeWorkerClassification | null {
	const activeBlockers = getBlockingBlockers(blockers);
	if (activeBlockers.length > 0) {
		return {
			decision: "blocked",
			summary: "This issue has unresolved blockers.",
			reason: `Issue is blocked by ${activeBlockers.length} open item(s): ${activeBlockers
				.map((blocker) => blocker.id)
				.join(", ")}`,
			comment:
				"Please resolve these open blockers before this issue can be started.",
			next_action: `blocked:${activeBlockers.map((blocker) => blocker.id).join(",")}`,
		};
	}

	return null;
}

function normalizeBlockedByDependency(
	dependency: GitHubBlockedByDependency,
	issueRepository: {
		owner: string;
		name: string;
	},
): IntakeResolvedBlocker {
	const repositoryId =
		dependency.repository.owner === issueRepository.owner &&
		dependency.repository.name === issueRepository.name
			? `#${dependency.number}`
			: `${dependency.repository.owner}/${dependency.repository.name}#${dependency.number}`;

	return {
		id: repositoryId,
		state: parseBlockerState(dependency.state.toLowerCase()),
		dependencyNumber: dependency.number,
		dependencyRepository: `${dependency.repository.owner}/${dependency.repository.name}`,
		dependencyTitle: dependency.title,
		dependencyHtmlUrl: dependency.htmlUrl,
	};
}

function parseClassifierOutput(raw: string): IntakeClassification {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new Error("Classifier output was empty.");
	}

	const parsed = tryParseJson(trimmed);
	if (!parsed) {
		throw new Error("Classifier output was not parseable JSON.");
	}

	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"content" in parsed &&
		typeof (parsed as { content?: unknown }).content === "string"
	) {
		const nested = tryParseJson((parsed as { content: string }).content);
		if (nested) {
			return intakeClassificationSchema.parse(nested);
		}
	}

	if (typeof parsed === "string") {
		const nested = tryParseJson(parsed);
		if (!nested) {
			throw new Error("Classifier output was not parseable JSON.");
		}
		return intakeClassificationSchema.parse(nested);
	}

	return intakeClassificationSchema.parse(parsed);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message || "Unknown classifier error.";
	}

	return "Unknown classifier error.";
}

function boundedErrorMessage(message: string, maxCharacters = 360): string {
	const trimmed = message.trim();
	if (trimmed.length <= maxCharacters) {
		return trimmed;
	}

	return `${trimmed.slice(0, maxCharacters - 1)}…`;
}

function safeTextPreview(text: string, maxCharacters: number): string {
	const normalized = text.replace(/\\s+/g, " ").trim();
	if (normalized.length <= maxCharacters) {
		return normalized;
	}

	return `${normalized.slice(0, maxCharacters - 1)}…`;
}

function boundedRedactedOutputPreview(
	text: string,
	maxCharacters = 500,
): string {
	return safeTextPreview(redactSensitiveText(text), maxCharacters);
}

function redactSensitiveText(input: string): string {
	return input
		.replace(
			/\b(?:api[_-]?key|token|secret|password|credential|pat|bearer)\s*[:=]\s*[^\s,"]{4,}/gi,
			"[redacted]",
		)
		.replace(
			/\b(?:access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,"]{4,}/gi,
			"[redacted]",
		)
		.replace(/\bbearer\s+[\w-]+/gi, "bearer [redacted]");
}

function isSafeCommand(command: string): boolean {
	return !/secret|token|api[_-]?key|password|credential/i.test(command);
}

function tryParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function hasExistingIntakeCommentForFingerprint(input: {
	client: Client;
	workItemId: string;
	inputFingerprint: string;
}): Promise<boolean> {
	try {
		const graph = await listWorkItemGraph(input.client, input.workItemId);
		return graph.artifacts.some((artifact) => {
			if (artifact.kind !== "intake_comment") {
				return false;
			}
			const metadata = asRecord(artifact.metadata);
			return (
				typeof metadata?.inputFingerprint === "string" &&
				metadata.inputFingerprint === input.inputFingerprint
			);
		});
	} catch {
		return false;
	}
}

async function safeListWorkItemGraph(
	client: Client,
	workItemId: string,
): Promise<WorkItemGraph> {
	try {
		return await listWorkItemGraph(client, workItemId);
	} catch {
		return {
			workItemId,
			workerRuns: [],
			decisions: [],
			artifacts: [],
			links: [],
		};
	}
}

function getLatestIntakeCommentCreatedAtMs(
	artifacts: WorkItemGraph["artifacts"],
): number | null {
	const latest = [...artifacts]
		.filter((artifact) => artifact.kind === "intake_comment")
		.sort((left, right) => right.createdAt - left.createdAt)[0];

	return latest ? latest.createdAt : null;
}

async function getHumanRepliesForWorkItem(input: {
	workItem: IntakeCuratorWorkItem;
	artifacts: WorkItemGraph["artifacts"];
	fetcher: IntakeIssueCommentFetcher;
}): Promise<GitHubIssueComment[]> {
	const boundaryMs = getLatestIntakeCommentCreatedAtMs(input.artifacts);
	if (boundaryMs === null) {
		return [];
	}

	try {
		const comments = await input.fetcher({
			owner: input.workItem.repository.owner,
			repository: input.workItem.repository.name,
			issueNumber: input.workItem.issueNumber,
		});

		return comments.filter((comment) => {
			const updatedAtMs = Date.parse(comment.updatedAt);
			return Number.isFinite(updatedAtMs) && updatedAtMs > boundaryMs;
		});
	} catch {
		return [];
	}
}

async function postIntakeComment(input: {
	client: Client;
	workItem: IntakeCuratorWorkItem;
	workerRunId: string;
	workItemId: string;
	classification: IntakeWorkerClassification;
	resolvedBlockers: IntakeResolvedBlocker[];
	commenter: IssueCommenter;
	inputFingerprint: string;
}): Promise<boolean> {
	const comment = buildIntakeIssueComment(
		input.workItem,
		input.classification,
		input.resolvedBlockers,
	);

	let commentResult: { id: number; htmlUrl: string };
	try {
		commentResult = await input.commenter({
			owner: input.workItem.repository.owner,
			repository: input.workItem.repository.name,
			issueNumber: input.workItem.issueNumber,
			body: comment,
		});
	} catch {
		return false;
	}

	const artifactId = await createArtifact(input.client, {
		workItemId: input.workItemId,
		workerRunId: input.workerRunId,
		kind: "intake_comment",
		externalId: String(commentResult.id),
		externalUrl: commentResult.htmlUrl,
		snapshot: {
			issueNumber: input.workItem.issueNumber,
			issueTitle: input.workItem.issueTitle,
		},
		metadata: {
			outcome: input.classification.decision,
			inputFingerprint: input.inputFingerprint,
		},
	});

	await createLink(input.client, {
		workItemId: input.workItemId,
		fromNodeType: "worker_run",
		fromNodeId: input.workerRunId,
		toNodeType: "artifact",
		toNodeId: artifactId,
		relation: "posts",
		metadata: {
			origin: "intake-curator",
		},
	});

	return true;
}

function buildIntakeIssueComment(
	workItem: IntakeCuratorWorkItem,
	classification: IntakeWorkerClassification,
	resolvedBlockers: IntakeResolvedBlocker[],
): string {
	const blockers = getBlockingBlockers(resolvedBlockers);
	const lines = [
		`Rhapsody intake classification: ${classification.decision} for #${workItem.issueNumber}`,
		`Summary: ${classification.summary}`,
		`Issue: ${workItem.issueTitle}`,
		`Comment: ${classification.comment}`,
	];

	if (classification.decision === "buildable") {
		lines.push(`Implementation plan: ${classification.implementation_plan}`);
	}

	if (classification.decision === "ask_human") {
		lines.push(`Question: ${classification.question}`);
	}

	if (
		classification.decision === "skip" ||
		classification.decision === "blocked"
	) {
		lines.push(`Reason: ${classification.reason}`);
	}

	const nextAction = pickNextAction(classification);
	if (nextAction) {
		lines.push(`Next action: ${nextAction}`);
	}

	if (classification.decision === "blocked" && blockers.length > 0) {
		lines.push(
			`Blocked by: ${blockers.map((blocker) => blocker.id).join(", ")}`,
		);
	}

	return lines.join("\n\n");
}

function buildIntakeClassificationPrompt(
	workItem: IntakeCuratorWorkItem,
	blockedBy: IntakeResolvedBlocker[],
	humanReplies?: GitHubIssueComment[],
): string {
	const blockedByText =
		blockedBy.length > 0
			? `Known blockers:\n${blockedBy
					.map((entry) => `- ${entry.id} (${entry.state})`)
					.join("\n")}`
			: "No configured blockers.";
	const repliesText =
		humanReplies && humanReplies.length > 0
			? `Human replies since Rhapsody asked:\n${humanReplies
					.map(
						(reply) =>
							`- ${reply.id} at ${reply.updatedAt}: ${reply.body || "(empty)"}`,
					)
					.join("\n")}`
			: "";

	return `Classify the following issue for build readiness.

Title: ${workItem.issueTitle}
Body: ${workItem.issueBody ?? "(empty)"}
Project status: ${workItem.projectStatus ?? "(none)"}
${blockedByText}
${repliesText}

Return JSON matching the provided schema with:
- decision: buildable | ask_human | skip
- summary: concise summary of your classification
- implementation_plan: required only for buildable
- question: required only for ask_human
- reason: required only for skip
- comment: required, include concrete next step or question
- next_action: optional next step

Notes:
- Use ask_human only when a human response is needed now.
- Use skip when work should intentionally wait for non-blocking external conditions.
- Do not classify configured blockers here; Rhapsody checks blockers before this classifier runs.
`;
}

function buildOutputMessagePath(
	nowMs: number | undefined,
	attempt: number,
): string {
	const dir = mkdtempSync(
		path.join(
			tmpdir(),
			`rhapsody-intake-classifier-${String(nowMs ?? Date.now())}-`,
		),
	);
	return path.join(dir, `attempt-${attempt}.json`);
}

async function ensureSchemaFile(overriddenPath?: string): Promise<string> {
	if (overriddenPath) {
		return overriddenPath;
	}

	const dir = mkdtempSync(path.join(tmpdir(), "rhapsody-intake-schema-"));
	const schemaPath = path.join(dir, "schema.json");
	await writeFile(
		schemaPath,
		JSON.stringify(intakeClassificationJsonSchema, null, 2),
		"utf8",
	);
	return schemaPath;
}

function pickNextAction(
	classification: IntakeWorkerClassification,
): string | null {
	if (classification.next_action?.trim()) {
		return classification.next_action.trim();
	}
	return null;
}

function computePolicyRuleId(
	decision: IntakeCuratorOutcome,
	deterministic: IntakeWorkerClassification | null,
): string {
	if (deterministic) {
		if (decision === "blocked") {
			return "intake.blocked";
		}
		if (decision === "skip") {
			return "intake.skip";
		}
		return "intake.ask_human";
	}

	return decision === "buildable"
		? "intake.codex.buildable"
		: decision === "skip"
			? "intake.codex.skip"
			: "intake.codex.ask_human";
}

function getClassificationReason(
	classification: IntakeWorkerClassification,
): string {
	if (classification.decision === "buildable") {
		return classification.implementation_plan;
	}

	if (classification.decision === "ask_human") {
		return classification.question;
	}

	return classification.reason;
}

function normalizeBlockedBy(
	blockedBy: Array<string | IntakeBlockerInput> | undefined,
): Array<{ id: string; state: IntakeBlockerState }> {
	const normalized = (blockedBy ?? []).reduce<
		Map<string, { id: string; state: IntakeBlockerState }>
	>((map, value) => {
		const parsed = parseBlocker(value);
		if (!parsed) {
			return map;
		}

		const current = map.get(parsed.id);
		if (!current) {
			map.set(parsed.id, parsed);
			return map;
		}

		if (!isBlockingBlocker(current.state) && isBlockingBlocker(parsed.state)) {
			map.set(parsed.id, parsed);
		}

		return map;
	}, new Map<string, { id: string; state: IntakeBlockerState }>());

	return Array.from(normalized.values()).sort((left, right) =>
		left.id.localeCompare(right.id),
	);
}

function parseBlocker(
	value: string | IntakeBlockerInput,
): { id: string; state: IntakeBlockerState } | null {
	if (typeof value === "string") {
		const id = value.trim();
		return id
			? {
					id,
					state: "unknown",
				}
			: null;
	}

	if (!value || typeof value !== "object") {
		return null;
	}

	if (typeof value.id !== "string" || !value.id.trim()) {
		return null;
	}

	const state = parseBlockerState(value.state);
	return {
		id: value.id.trim(),
		state,
	};
}

function parseBlockerState(state: unknown): IntakeBlockerState {
	if (state === "open") {
		return "open";
	}

	if (state === "closed") {
		return "closed";
	}

	return "unknown";
}

function isBlockingBlocker(state: IntakeBlockerState): boolean {
	return state !== "closed";
}

function getBlockingBlockers(
	blockers: Array<{ id: string; state: IntakeBlockerState }>,
): Array<{ id: string; state: IntakeBlockerState }> {
	return blockers.filter((blocker) => isBlockingBlocker(blocker.state));
}

function findFreshIntakeDecision(input: {
	decisions: Decision[];
	inputFingerprint: string;
}): Decision | null {
	const outcome = input.decisions.find((decision) => {
		if (decision.phase !== "intake") {
			return false;
		}

		const evidence = asRecord(decision.evidence);
		return evidence?.inputFingerprint === input.inputFingerprint;
	});

	return outcome ?? null;
}

function normalizeOutcome(value: string): IntakeCuratorOutcome {
	if (
		value === "buildable" ||
		value === "ask_human" ||
		value === "skip" ||
		value === "blocked"
	) {
		return value;
	}

	if (value === "blocked_by") {
		return "blocked";
	}

	return "skip";
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null
		? (value as Record<string, unknown>)
		: null;
}
