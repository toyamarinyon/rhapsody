import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createClient, type Client } from "@libsql/client";
import { expect, test, vi } from "vitest";
import { createArtifact, migrateStateStore } from "@/lib/state";
import {
	buildIssueStatusCommentMarker,
	renderIssueStatusComment,
	upsertIssueStatusComment,
} from "@/lib/github/issue-status-comment";

async function createTestDatabase(): Promise<{
	client: Client;
	cleanup: () => void;
}> {
	const directory = mkdtempSync(path.join(tmpdir(), "rhapsody-issue-comment-"));
	const client = createClient({
		url: `file:${path.join(directory, "state.db")}`,
	});
	await migrateStateStore(client);
	return {
		client,
		cleanup: () => rmSync(directory, { force: true, recursive: true }),
	};
}

test("renderIssueStatusComment covers the core lifecycle fields", () => {
	const body = renderIssueStatusComment({
		workItemId: "github_issue:owner/repo#1",
		issueNumber: 1,
		issueTitle: "Add status comments",
		status: "running",
		currentStep: "Intake classification started",
		updatedAt: 1_000,
		dashboardUrl: "https://dashboard.test/issues/1",
		latestRun: {
			id: "wrn_1",
			kind: "intake_curator",
			status: "running",
			updatedAt: 2_000,
		},
		pullRequestUrl: "https://github.com/owner/repo/pull/2",
		lastHeartbeat: "2026-01-01T00:00:00Z",
		latestEvent: {
			type: "intake.classification.completed",
			message: "done",
		},
		failurePoint: null,
	});

	expect(body).toContain("Rhapsody is working on this issue.");
	expect(body).toContain(
		"| running | Intake classification started | 1970-01-01 00:00:01 UTC |",
	);
	expect(body).toContain(
		"| Dashboard | [View work item](https://dashboard.test/issues/1) |",
	);
	expect(body).toContain(
		"| Pull request | [View pull request](https://github.com/owner/repo/pull/2) |",
	);
	expect(body).toContain(
		'<!-- rhapsody:issue-status-comment workItemId="github_issue:owner/repo#1" -->',
	);
});

test("buildIssueStatusCommentMarker returns the canonical rendered marker", () => {
	expect(buildIssueStatusCommentMarker("github_issue:owner/repo#1")).toBe(
		'<!-- rhapsody:issue-status-comment workItemId="github_issue:owner/repo#1" -->',
	);
});

test("upsertIssueStatusComment creates, reuses, and updates an issue status comment", async () => {
	const database = await createTestDatabase();
	const client = database.client;
	const updater = vi.fn(async (input: { commentId: number; body: string }) => ({
		id: input.commentId,
		htmlUrl: `https://github.com/owner/repo/issues/1#issuecomment-${input.commentId}`,
	}));

	try {
		const created = await upsertIssueStatusComment({
			client,
			workItemId: "github_issue:owner/repo#1",
			owner: "owner",
			repository: "repo",
			issueNumber: 1,
			issueTitle: "Status comment",
			status: "running",
			currentStep: "Intake classification started",
			updatedAt: 1_000,
			dashboardUrl: null,
			latestRun: null,
			pullRequestUrl: null,
			lastHeartbeat: null,
			latestEvent: null,
			failurePoint: null,
			commenter: vi.fn(async () => ({
				id: 7,
				htmlUrl: "https://github.com/owner/repo/issues/1#issuecomment-7",
			})),
			updater,
			fetcher: vi.fn(async () => []),
		});

		expect(created.ok).toBe(true);
		const artifactRows = await client.execute({
			sql: `SELECT kind, external_id, external_url, metadata_json FROM artifacts WHERE work_item_id = ?`,
			args: ["github_issue:owner/repo#1"],
		});
		expect(artifactRows.rows[0]).toMatchObject({
			kind: "issue_status_comment",
			external_id: "7",
			external_url: "https://github.com/owner/repo/issues/1#issuecomment-7",
		});
		expect(
			JSON.parse(
				(artifactRows.rows[0] as unknown as { metadata_json: string })
					.metadata_json,
			),
		).toMatchObject({
			marker: buildIssueStatusCommentMarker("github_issue:owner/repo#1"),
		});

		await upsertIssueStatusComment({
			client,
			workItemId: "github_issue:owner/repo#1",
			owner: "owner",
			repository: "repo",
			issueNumber: 1,
			issueTitle: "Status comment",
			status: "completed",
			currentStep: "Classification completed",
			updatedAt: 2_000,
			dashboardUrl: null,
			latestRun: null,
			pullRequestUrl: null,
			lastHeartbeat: null,
			latestEvent: null,
			failurePoint: null,
			updater,
		});

		expect(updater).toHaveBeenCalled();
	} finally {
		client.close();
		database.cleanup();
	}
});

test("upsertIssueStatusComment reuses an existing comment found by marker", async () => {
	const database = await createTestDatabase();
	const client = database.client;

	try {
		await createArtifact(client, {
			workItemId: "github_issue:owner/repo#2",
			kind: "issue_status_comment",
			externalId: "88",
			externalUrl: "https://github.com/owner/repo/issues/2#issuecomment-88",
			metadata: {
				marker: buildIssueStatusCommentMarker("github_issue:owner/repo#2"),
			},
		});

		const updater = vi.fn(
			async (input: { commentId: number; body: string }) => ({
				id: input.commentId,
				htmlUrl: `https://github.com/owner/repo/issues/2#issuecomment-${input.commentId}`,
			}),
		);

		const result = await upsertIssueStatusComment({
			client,
			workItemId: "github_issue:owner/repo#2",
			owner: "owner",
			repository: "repo",
			issueNumber: 2,
			issueTitle: "Reuse",
			status: "running",
			currentStep: "Intake classification started",
			updatedAt: 1_000,
			dashboardUrl: null,
			latestRun: null,
			pullRequestUrl: null,
			lastHeartbeat: null,
			latestEvent: null,
			failurePoint: null,
			updater,
			fetcher: vi.fn(async () => [
				{
					id: 88,
					body: `hello\n${buildIssueStatusCommentMarker("github_issue:owner/repo#2")}`,
					htmlUrl: "https://github.com/owner/repo/issues/2#issuecomment-88",
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					authorLogin: "human",
				},
			]),
		});

		expect(result.ok).toBe(true);
		expect(updater).toHaveBeenCalledWith({
			owner: "owner",
			repository: "repo",
			commentId: 88,
			body: expect.stringContaining("Rhapsody is working on this issue."),
		});
	} finally {
		client.close();
		database.cleanup();
	}
});

test("upsertIssueStatusComment reuses an existing rendered managed comment from fetch", async () => {
	const database = await createTestDatabase();
	const client = database.client;

	try {
		const renderedBody = renderIssueStatusComment({
			workItemId: "github_issue:owner/repo#4",
			issueNumber: 4,
			issueTitle: "Reuse rendered",
			status: "running",
			currentStep: "Intake classification started",
			updatedAt: 1_000,
			dashboardUrl: null,
			latestRun: null,
			pullRequestUrl: null,
			lastHeartbeat: null,
			latestEvent: null,
			failurePoint: null,
		});

		const updater = vi.fn(
			async (input: { commentId: number; body: string }) => ({
				id: input.commentId,
				htmlUrl: `https://github.com/owner/repo/issues/4#issuecomment-${input.commentId}`,
			}),
		);

		const result = await upsertIssueStatusComment({
			client,
			workItemId: "github_issue:owner/repo#4",
			owner: "owner",
			repository: "repo",
			issueNumber: 4,
			issueTitle: "Reuse rendered",
			status: "completed",
			currentStep: "Classification completed",
			updatedAt: 2_000,
			dashboardUrl: null,
			latestRun: null,
			pullRequestUrl: null,
			lastHeartbeat: null,
			latestEvent: null,
			failurePoint: null,
			updater,
			fetcher: vi.fn(async () => [
				{
					id: 144,
					body: `Existing comment\n${renderedBody}`,
					htmlUrl: "https://github.com/owner/repo/issues/4#issuecomment-144",
					createdAt: "2026-01-01T00:00:00Z",
					updatedAt: "2026-01-01T00:00:00Z",
					authorLogin: "human",
				},
			]),
		});

		expect(result.ok).toBe(true);
		expect(updater).toHaveBeenCalledWith({
			owner: "owner",
			repository: "repo",
			commentId: 144,
			body: expect.stringContaining("Rhapsody completed this issue."),
		});
		const artifactRows = await client.execute({
			sql: `SELECT external_id, external_url, metadata_json FROM artifacts WHERE work_item_id = ? AND kind = ?`,
			args: ["github_issue:owner/repo#4", "issue_status_comment"],
		});
		expect(artifactRows.rows[0]).toMatchObject({
			external_id: "144",
			external_url: "https://github.com/owner/repo/issues/4#issuecomment-144",
		});
		expect(
			JSON.parse(
				(artifactRows.rows[0] as unknown as { metadata_json: string })
					.metadata_json,
			),
		).toMatchObject({
			marker: buildIssueStatusCommentMarker("github_issue:owner/repo#4"),
		});
	} finally {
		client.close();
		database.cleanup();
	}
});

test("upsertIssueStatusComment returns failure when the GitHub update fails", async () => {
	const database = await createTestDatabase();
	const client = database.client;

	try {
		await createArtifact(client, {
			workItemId: "github_issue:owner/repo#3",
			kind: "issue_status_comment",
			externalId: "99",
			externalUrl: "https://github.com/owner/repo/issues/3#issuecomment-99",
			metadata: {
				marker: buildIssueStatusCommentMarker("github_issue:owner/repo#3"),
			},
		});

		const result = await upsertIssueStatusComment({
			client,
			workItemId: "github_issue:owner/repo#3",
			owner: "owner",
			repository: "repo",
			issueNumber: 3,
			issueTitle: "Failure",
			status: "running",
			currentStep: "Intake classification started",
			updatedAt: 1_000,
			dashboardUrl: null,
			latestRun: null,
			pullRequestUrl: null,
			lastHeartbeat: null,
			latestEvent: null,
			failurePoint: null,
			updater: vi.fn(async () => {
				throw new Error("update denied");
			}),
		});

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toBe("update denied");
		}
	} finally {
		client.close();
		database.cleanup();
	}
});
