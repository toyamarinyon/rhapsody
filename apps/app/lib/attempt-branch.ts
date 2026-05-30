const ATTEMPT_BRANCH_PREFIX_DEFAULT = "rhapsody";

export type BuildAttemptBranchNameInput = {
	branchPrefix: string;
	issueNumber: number | string | null;
	attemptNumber: number;
};

export type ParseWorkItemIssueNumberInput = {
	workItemId: string;
};

export function buildAttemptBranchName(
	input: BuildAttemptBranchNameInput,
): string {
	const branchPrefix = normalizeBranchPrefix(input.branchPrefix);
	const issuePart = buildIssueBranchPart(input.issueNumber);
	const attemptPart = Math.max(1, Math.floor(input.attemptNumber || 0));

	return `${branchPrefix}/${issuePart}-${attemptPart}`;
}

export function parseWorkItemIssueNumber(
	input: ParseWorkItemIssueNumberInput,
): number | null {
	const value = input.workItemId.match(/#(\d+)$/);

	if (!value) {
		return null;
	}

	return Number.parseInt(value[1], 10);
}

export function normalizeBranchPrefix(
	branchPrefix: string | undefined,
): string {
	const normalized = branchPrefix?.trim().replace(/\/+$/u, "") ?? "";

	return normalized || ATTEMPT_BRANCH_PREFIX_DEFAULT;
}

function buildIssueBranchPart(issueNumber: number | string | null): string {
	if (issueNumber === null) {
		return "issue-unknown";
	}

	const issuePart = String(issueNumber).trim();

	if (!issuePart) {
		return "issue-unknown";
	}

	return `issue-${normalizeBranchPart(issuePart)}`;
}

function normalizeBranchPart(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]/gu, "-");
	return normalized.replace(/(^[-.]+|[-.]+$)/g, "") || "unknown";
}
