import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";

import { z } from "zod";

import {
	createArtifact,
	createDecision,
	createLink,
	createWorkerRun,
	listWorkItemGraph,
	updateWorkerRunStatus,
	type Decision,
} from "@/lib/state";
import { createIssueComment } from "@/lib/github/issues";
import { buildCodexExecCommand, runCodexExec } from "@/lib/codex/cli";
import type { GitHubProjectIssueWorkItem } from "@/lib/github/project-items";
import type { Client } from "@libsql/client";

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

export type IssueCommenter = (input: {
	owner: string;
	repository: string;
	issueNumber: number;
	body: string;
}) => Promise<{ id: number; htmlUrl: string }>;

export type IntakeCuratorOptions = {
	existingDecisions?: Decision[];
	classify?: IntakeClassifierRunner;
	nowMs?: number;
	comment?: IssueCommenter;
	schemaFilePath?: string;
};

const DEFAULT_CLASSIFIER_MODEL = "gpt-5.4-mini";
const DEFAULT_CLASSIFIER_TIMEOUT_MS = 120_000;

export async function runIntakeCurator(
	client: Client,
	workItem: IntakeCuratorWorkItem,
	workItemId: string,
	options: IntakeCuratorOptions = {},
): Promise<IntakeCuratorResult> {
	const inputFingerprint = buildIntakeInputFingerprint(workItem);
	const deterministic = inferDeterministicClassification(workItem);
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

	const classification = deterministic
		? deterministic
		: await classifyWithHealing(workItem, {
				runner: options.classify ?? runCodexIntakeClassification,
				schemaFilePath: options.schemaFilePath,
				nowMs: options.nowMs,
			});

	const normalizedBlockedBy = normalizeBlockedBy(workItem.blockedBy);
	const workerRun = await createWorkerRun(client, {
		workItemId,
		kind: "intake_curator",
		status: "completed",
		metadata: {
			issueNumber: workItem.issueNumber,
			issueTitle: workItem.issueTitle,
		},
	});

	const decisionEvidence = {
		inputFingerprint,
		issueTitle: workItem.issueTitle,
		issueNumber: workItem.issueNumber,
		projectStatus: workItem.projectStatus ?? null,
		blockedBy: normalizedBlockedBy,
		projectMetadata: workItem.projectMetadata ?? null,
		summary: classification.summary,
		reason: getClassificationReason(classification),
		nextAction: pickNextAction(classification),
		comment: classification.comment ?? null,
		policyRuleId: computePolicyRuleId(classification.decision, deterministic),
	};

	const decisionId = await createDecision(client, {
		workItemId,
		workerRunId: workerRun.id,
		phase: "intake",
		deterministic: deterministic !== null,
		policyVersion: "v1",
		policyRuleId: decisionEvidence.policyRuleId,
		outcome: classification.decision,
		nextWorkerKind: classification.decision === "buildable" ? "builder" : null,
		evidence: decisionEvidence,
		nextAction: decisionEvidence.nextAction ?? undefined,
	});

	await updateWorkerRunStatus(client, {
		id: workerRun.id,
		status: "completed",
	});

	let commentPosted = false;
	if (
		classification.comment.trim() &&
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
			classification,
			commenter: options.comment ?? createIssueComment,
			inputFingerprint,
		});
	}

	return {
		decisionId,
		workerRunId: workerRun.id,
		outcome: classification.decision,
		nextAction: decisionEvidence.nextAction ?? undefined,
		shouldStartBuilder: classification.decision === "buildable",
		skippedFreshDuplicate: false,
		inputFingerprint,
		commentPosted,
		classificationReason: getClassificationReason(classification),
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
): string {
	const normalized = {
		issueTitle: (workItem.issueTitle ?? "").trim(),
		issueBody: (workItem.issueBody ?? "").trim(),
		issueNumber: workItem.issueNumber,
		blockedBy: normalizeBlockedBy(workItem.blockedBy),
		projectStatus: workItem.projectStatus ?? null,
	};

	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

async function classifyWithHealing(
	workItem: IntakeCuratorWorkItem,
	options: {
		runner: IntakeClassifierRunner;
		nowMs?: number;
		schemaFilePath?: string;
	},
): Promise<IntakeClassification> {
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		try {
			const prompt = buildIntakeClassificationPrompt(workItem);
			const schemaFilePath = await ensureSchemaFile(options.schemaFilePath);
			const outputMessagePath = buildOutputMessagePath(options.nowMs, attempt);
			const result = await options.runner({
				prompt,
				schemaFilePath,
				outputMessagePath,
				workItem,
				attempt,
			});
			return intakeClassificationSchema.parse(result.classification);
		} catch {
			// Fall through to a single healing attempt, then deterministic fallback.
		}
	}

	return {
		decision: "ask_human",
		summary: "Rhapsody could not safely classify this issue automatically.",
		question:
			"Could you clarify the expected change and acceptance criteria before Rhapsody starts implementation?",
		comment:
			"Please clarify remaining scope and constraints so Rhapsody can proceed safely.",
		next_action: "add_context_and_acceptance_criteria",
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
		throw new Error(
			`Codex intake classification failed (code=${result.exitCode}, timedOut=${result.timedOut}).`,
		);
	}

	const raw = await readFile(outputMessagePath, "utf8");
	return {
		classification: parseClassifierOutput(raw),
		raw,
		command: command.argv.join(" "),
	};
}

function inferDeterministicClassification(
	workItem: IntakeCuratorWorkItem,
): IntakeWorkerClassification | null {
	const activeBlockers = getBlockingBlockers(
		normalizeBlockedBy(workItem.blockedBy),
	);
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

async function postIntakeComment(input: {
	client: Client;
	workItem: IntakeCuratorWorkItem;
	workerRunId: string;
	workItemId: string;
	classification: IntakeWorkerClassification;
	commenter: IssueCommenter;
	inputFingerprint: string;
}): Promise<boolean> {
	const comment = buildIntakeIssueComment(input.workItem, input.classification);

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
): string {
	const blockers = getBlockingBlockers(normalizeBlockedBy(workItem.blockedBy));
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
): string {
	const blockedBy = normalizeBlockedBy(workItem.blockedBy);
	const blockedByText =
		blockedBy.length > 0
			? `Known blockers:\n${blockedBy
					.map((entry) => `- ${entry.id} (${entry.state})`)
					.join("\n")}`
			: "No configured blockers.";

	return `Classify the following issue for build readiness.

Title: ${workItem.issueTitle}
Body: ${workItem.issueBody ?? "(empty)"}
Project status: ${workItem.projectStatus ?? "(none)"}
${blockedByText}

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
