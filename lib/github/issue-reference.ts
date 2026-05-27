type RepositoryReference = {
	owner: string;
	name: string;
};

const ISSUE_LINK_KEYWORD_PATTERN =
	/\b(?:close|closes|closed|fix|fixes|fixed|resolve|resolves|resolved)\b/iu;

export function appendIssueReference(
	body: string,
	issueNumber: number | null,
	repository?: RepositoryReference,
) {
	if (issueNumber === null) {
		return body;
	}

	const reference = `Resolves #${issueNumber}`;
	const issuePattern = buildIssueLinkPattern(issueNumber, repository);

	if (issuePattern.test(body)) {
		return body;
	}

	return `${body.trimEnd()}\n\n${reference}`;
}

export function containsIssueReference(
	body: string | null | undefined,
	issueNumber: number,
	repository?: RepositoryReference,
) {
	return buildIssueLinkPattern(issueNumber, repository).test(body ?? "");
}

function buildIssueLinkPattern(
	issueNumber: number,
	repository?: RepositoryReference,
) {
	const sameRepositoryReference = repository
		? `(?:${escapeRegExp(repository.owner)}/${escapeRegExp(repository.name)})?`
		: "";

	return new RegExp(
		`${ISSUE_LINK_KEYWORD_PATTERN.source}(?:\\s+|:\\s*)${sameRepositoryReference}#${issueNumber}(?!\\d)`,
		ISSUE_LINK_KEYWORD_PATTERN.flags,
	);
}

function escapeRegExp(value: string) {
	return value.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
