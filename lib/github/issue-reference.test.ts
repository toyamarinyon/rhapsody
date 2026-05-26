import { expect, test } from "vitest";
import { appendIssueReference } from "./issue-reference";

const repository = {
	owner: "toyamarinyon",
	name: "rhapsody",
};

test("appends a supported issue-link keyword when the body lacks one", () => {
	expect(
		appendIssueReference("Implements the runner fix.", 56, repository),
	).toBe("Implements the runner fix.\n\nResolves #56");
});

test("does not append when the body already contains a supported keyword", () => {
	expect(
		appendIssueReference(
			"Implements the runner fix.\n\nCloses: #56",
			56,
			repository,
		),
	).toBe("Implements the runner fix.\n\nCloses: #56");
});

test("matches supported keywords case-insensitively", () => {
	expect(
		appendIssueReference(
			"Implements the runner fix.\n\nrEsOlVeD toyamarinyon/rhapsody#56",
			56,
			repository,
		),
	).toBe("Implements the runner fix.\n\nrEsOlVeD toyamarinyon/rhapsody#56");
});

test("does not treat unsupported refs wording as sufficient linkage", () => {
	expect(
		appendIssueReference(
			"Implements the runner fix.\n\nRefs #56",
			56,
			repository,
		),
	).toBe("Implements the runner fix.\n\nRefs #56\n\nResolves #56");
});

test("does not treat a different repository issue reference as the same issue", () => {
	expect(
		appendIssueReference(
			"Implements the runner fix.\n\nFixes other/repo#56",
			56,
			repository,
		),
	).toBe("Implements the runner fix.\n\nFixes other/repo#56\n\nResolves #56");
});

test("returns the body unchanged when no work-item issue number is available", () => {
	expect(
		appendIssueReference("Implements the runner fix.", null, repository),
	).toBe("Implements the runner fix.");
});
