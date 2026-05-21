import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RhapsodyProjectConfig } from "@/lib/config";
import type { RunDetail, StateStoreAttempt } from "@/lib/state";

export const RHAPSODY_INSTRUCTION_PATH = ".rhapsody/INSTRUCTIONS.md";

export type InstructionValue =
	| string
	| number
	| boolean
	| null
	| InstructionValue[]
	| InstructionContextObject;
export type InstructionContextObject = {
	[key: string]: InstructionValue | undefined;
};

export type InstructionRenderContext = {
	item: InstructionContextObject;
	run: InstructionContextObject;
	attempt: InstructionContextObject;
	repository: InstructionContextObject;
	project: InstructionContextObject;
};

export type LoadedInstructions = {
	template: string;
	instructionPath: string;
};

export class InstructionTemplateError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "InstructionTemplateError";
	}
}

export async function loadRepositoryInstructions(
	repositoryRoot = process.cwd(),
): Promise<LoadedInstructions> {
	const instructionPath = path.join(repositoryRoot, RHAPSODY_INSTRUCTION_PATH);
	const template = (await readFile(instructionPath, "utf8")).trim();

	if (hasYamlFrontMatter(template)) {
		throw new InstructionTemplateError(
			"YAML front matter is not supported in Rhapsody instructions.",
		);
	}

	return { template, instructionPath: RHAPSODY_INSTRUCTION_PATH };
}

export function renderRepositoryInstructions(input: {
	template: string;
	context: InstructionRenderContext;
	includeHostConstraints?: boolean;
}): string {
	const rendered = renderStrictTemplate(input.template, input.context);

	if (input.includeHostConstraints === false) {
		return rendered;
	}

	return `${rendered.trim()}\n\n${RHAPSODY_HOST_CONSTRAINTS}`;
}

export function renderStrictTemplate(
	template: string,
	context: InstructionRenderContext,
): string {
	return template.replaceAll(
		/\{\{([^}]*)\}\}/g,
		(_match, rawExpression: string) => {
			const expression = rawExpression.trim();

			if (!expression) {
				throw new InstructionTemplateError(
					"Template variable expression cannot be empty.",
				);
			}

			if (expression.includes("|")) {
				throw new InstructionTemplateError(
					`Template filters are not supported: ${expression}`,
				);
			}

			const pathSegments = expression.split(".");

			if (!pathSegments.every(isTemplateIdentifier)) {
				throw new InstructionTemplateError(
					`Invalid template variable expression: ${expression}`,
				);
			}

			const value = resolveTemplateValue(context, pathSegments, expression);
			return stringifyTemplateValue(value);
		},
	);
}

export function buildInstructionContext(input: {
	detail: RunDetail;
	attempt: StateStoreAttempt;
	config: RhapsodyProjectConfig;
}): InstructionRenderContext {
	const { config, detail, attempt } = input;
	const snapshot = asInstructionObject(detail.run.workItemSnapshot);
	const issue = asInstructionObject(snapshot.issue);
	const snapshotRepository = asInstructionObject(snapshot.repository);
	const identifier =
		stringFromSnapshot(issue.identifier) ??
		stringFromSnapshot(snapshot.identifier) ??
		detail.run.workItemId;
	const title =
		stringFromSnapshot(issue.title) ??
		stringFromSnapshot(snapshot.title) ??
		detail.run.workItemTitle;
	const body = stringFromSnapshot(issue.body);
	const url =
		stringFromSnapshot(issue.htmlUrl) ??
		stringFromSnapshot(issue.url) ??
		stringFromSnapshot(snapshot.url) ??
		detail.run.workItemUrl;
	const owner =
		stringFromSnapshot(snapshotRepository.owner) ?? config.repository.owner;
	const repositoryName =
		stringFromSnapshot(snapshotRepository.name) ?? config.repository.name;

	return {
		item: {
			id: detail.run.workItemId,
			identifier,
			title,
			body,
			url,
			state: stringFromSnapshot(issue.state) ?? detail.run.workItemStatus,
			projectStatus: detail.run.workItemStatus,
			source: stringFromSnapshot(snapshot.source),
			number: numberFromSnapshot(issue.number),
		},
		run: {
			id: detail.run.id,
			status: detail.run.status,
			createdAt: detail.run.createdAt,
			updatedAt: detail.run.updatedAt,
			startedAt: detail.run.startedAt,
			finishedAt: detail.run.finishedAt,
		},
		attempt: {
			id: attempt.id,
			runId: attempt.runId,
			number: attempt.attemptNumber,
			status: attempt.status,
			sandboxId: attempt.sandboxId,
			command: attempt.command,
			exitCode: attempt.exitCode,
			createdAt: attempt.createdAt,
			updatedAt: attempt.updatedAt,
			startedAt: attempt.startedAt,
			finishedAt: attempt.finishedAt,
		},
		repository: {
			owner,
			name: repositoryName,
			defaultBranch: config.repository.defaultBranch,
			branchPrefix: config.repository.branchPrefix,
		},
		project: {
			owner: config.tracker.owner,
			repository: config.tracker.repository,
			number: config.tracker.projectNumber,
			statusField: config.tracker.statusField,
		},
	};
}

const RHAPSODY_HOST_CONSTRAINTS = [
	"## Rhapsody Host Constraints",
	"",
	"- Use mediated GitHub access exposed by Rhapsody. Do not expect raw GitHub credentials in the workspace.",
	"- Create branches with the configured repository branch prefix when a code change is needed.",
	"- Do not print, persist, or request raw credentials or tokens.",
	"- Report attempt completion through the Rhapsody callback contract when execution is finished.",
].join("\n");

function resolveTemplateValue(
	context: InstructionRenderContext,
	pathSegments: string[],
	expression: string,
): InstructionValue | undefined {
	let current: InstructionValue | undefined = context;

	for (const segment of pathSegments) {
		if (!isInstructionObject(current) || !(segment in current)) {
			throw new InstructionTemplateError(
				`Unknown template variable: ${expression}`,
			);
		}

		current = current[segment];
	}

	if (current === undefined) {
		throw new InstructionTemplateError(
			`Unknown template variable: ${expression}`,
		);
	}

	return current;
}

function stringifyTemplateValue(value: InstructionValue | undefined): string {
	if (value === undefined || value === null) {
		return "";
	}

	if (typeof value === "string") {
		return value;
	}

	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}

	return JSON.stringify(value);
}

function hasYamlFrontMatter(template: string): boolean {
	return template.startsWith("---\n") || template === "---";
}

function isTemplateIdentifier(value: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function isInstructionObject(
	value: unknown,
): value is InstructionContextObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asInstructionObject(value: unknown): InstructionContextObject {
	if (isInstructionObject(value)) {
		return value;
	}

	return {};
}

function stringFromSnapshot(
	value: InstructionValue | undefined,
): string | null {
	return typeof value === "string" ? value : null;
}

function numberFromSnapshot(
	value: InstructionValue | undefined,
): number | null {
	return typeof value === "number" ? value : null;
}
