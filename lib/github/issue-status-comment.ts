import type { Client } from "@libsql/client";
import { createArtifact, createLink, type Artifact } from "@/lib/state";
import {
	createIssueComment,
	fetchIssueComments,
	updateIssueComment,
	type GitHubIssueComment,
} from "@/lib/github/issues";

export const ISSUE_STATUS_COMMENT_KIND = "issue_status_comment";
export const ISSUE_STATUS_COMMENT_MARKER =
	'<!-- rhapsody:issue-status-comment workItemId="';
const ISSUE_STATUS_COMMENT_MARKER_SUFFIX = '" -->';

export type IssueStatusCommentArtifact = Artifact & {
	kind: typeof ISSUE_STATUS_COMMENT_KIND;
};

export type IssueStatusCommentSnapshot = {
	status: string | null;
	currentStep: string | null;
	updatedAt: string;
	dashboardUrl: string | null;
	latestRun: {
		id: string;
		status: string;
		runner: string;
		updatedAt: number;
	} | null;
	pullRequestUrl: string | null;
	lastHeartbeat: string | null;
	latestEvent: {
		type: string;
		message: string | null;
	} | null;
	failurePoint: string | null;
};

type IssueStatusCommentRun = {
	id: string;
	status: string;
	kind: string;
	updatedAt: number;
};

export type IssueStatusCommentRenderInput = {
	workItemId: string;
	issueNumber: number;
	issueTitle: string;
	status: string | null;
	currentStep: string | null;
	updatedAt: number;
	dashboardUrl: string | null;
	latestRun: IssueStatusCommentRun | null;
	pullRequestUrl: string | null;
	lastHeartbeat: string | null;
	latestEvent: { type: string; message: string | null } | null;
	failurePoint: string | null;
};

export function renderIssueStatusComment(input: IssueStatusCommentRenderInput) {
	const intro = getIssueStatusCommentIntro(input.status);
	const status = input.status ?? "unknown";
	const currentStep =
		input.currentStep ?? "Waiting for the next scheduler step";
	const updated = formatUtc(input.updatedAt);
	const lines = [
		intro,
		"",
		"| Status | Current step | Updated |",
		"| --- | --- | --- |",
		`| ${escapeTableCell(status)} | ${escapeTableCell(currentStep)} | ${escapeTableCell(updated)} |`,
	];

	const links: Array<[string, string]> = [];

	if (input.dashboardUrl) {
		links.push(["Dashboard", `[View work item](${input.dashboardUrl})`]);
	}

	if (input.latestRun) {
		links.push([
			"Latest run",
			input.dashboardUrl
				? `[${input.latestRun.id}](${input.dashboardUrl})`
				: `${input.latestRun.id} (${input.latestRun.kind} ${input.latestRun.status})`,
		]);
	}

	if (input.pullRequestUrl) {
		links.push([
			"Pull request",
			`[View pull request](${input.pullRequestUrl})`,
		]);
	}

	if (links.length > 0) {
		lines.push("", "| Links | |", "| --- | --- |");
		for (const [label, value] of links) {
			lines.push(`| ${escapeTableCell(label)} | ${value} |`);
		}
	}

	if (input.lastHeartbeat) {
		lines.push("", `Last heartbeat: ${input.lastHeartbeat}`);
	}

	if (input.latestEvent) {
		lines.push(
			`Latest event: ${input.latestEvent.type}${input.latestEvent.message ? ` - ${input.latestEvent.message}` : ""}`,
		);
	}

	if (input.failurePoint) {
		lines.push(`Failure point: ${input.failurePoint}`);
	}

	lines.push("", buildIssueStatusCommentMarker(input.workItemId));
	return lines.join("\n");
}

export async function upsertIssueStatusComment(input: {
	client: Client;
	workItemId: string;
	owner: string;
	repository: string;
	issueNumber: number;
	issueTitle: string;
	status: string | null;
	currentStep: string | null;
	updatedAt: number;
	dashboardUrl: string | null;
	latestRun: IssueStatusCommentRun | null;
	pullRequestUrl: string | null;
	lastHeartbeat: string | null;
	latestEvent: { type: string; message: string | null } | null;
	failurePoint: string | null;
	workerRunId?: string | null;
	commenter?: typeof createIssueComment;
	updater?: typeof updateIssueComment;
	fetcher?: typeof fetchIssueComments;
}): Promise<
	| {
			ok: true;
			commentId: number;
			commentUrl: string;
	  }
	| {
			ok: false;
			error: string;
	  }
> {
	const commentBody = renderIssueStatusComment({
		workItemId: input.workItemId,
		issueNumber: input.issueNumber,
		issueTitle: input.issueTitle,
		status: input.status,
		currentStep: input.currentStep,
		updatedAt: input.updatedAt,
		dashboardUrl: input.dashboardUrl,
		latestRun: input.latestRun,
		pullRequestUrl: input.pullRequestUrl,
		lastHeartbeat: input.lastHeartbeat,
		latestEvent: input.latestEvent,
		failurePoint: input.failurePoint,
	});
	const existingArtifact = await findExistingIssueStatusCommentArtifact(
		input.client,
		input.workItemId,
	);
	const fetcher = input.fetcher ?? fetchIssueComments;
	const commenter = input.commenter ?? createIssueComment;
	const updater = input.updater ?? updateIssueComment;

	try {
		if (existingArtifact?.externalId) {
			const comment = await updater({
				owner: input.owner,
				repository: input.repository,
				commentId: Number(existingArtifact.externalId),
				body: commentBody,
			});
			return {
				ok: true,
				commentId: comment.id,
				commentUrl: comment.htmlUrl,
			};
		}

		const reusableComment = await findReusableIssueStatusComment({
			fetcher,
			owner: input.owner,
			repository: input.repository,
			issueNumber: input.issueNumber,
			workItemId: input.workItemId,
		});

		if (reusableComment) {
			const artifactId = await createArtifact(input.client, {
				workItemId: input.workItemId,
				workerRunId: input.workerRunId ?? null,
				kind: ISSUE_STATUS_COMMENT_KIND,
				externalId: String(reusableComment.id),
				externalUrl: reusableComment.htmlUrl,
				metadata: {
					marker: buildIssueStatusCommentMarker(input.workItemId),
				},
			});
			await maybeLinkArtifact(input.client, {
				artifactId,
				workItemId: input.workItemId,
				workerRunId: input.workerRunId,
			});
			const comment = await updater({
				owner: input.owner,
				repository: input.repository,
				commentId: reusableComment.id,
				body: commentBody,
			});
			return {
				ok: true,
				commentId: comment.id,
				commentUrl: comment.htmlUrl,
			};
		}

		const created = await commenter({
			owner: input.owner,
			repository: input.repository,
			issueNumber: input.issueNumber,
			body: commentBody,
		});

		const artifactId = await createArtifact(input.client, {
			workItemId: input.workItemId,
			workerRunId: input.workerRunId ?? null,
			kind: ISSUE_STATUS_COMMENT_KIND,
			externalId: String(created.id),
			externalUrl: created.htmlUrl,
			metadata: {
				marker: buildIssueStatusCommentMarker(input.workItemId),
			},
		});
		await maybeLinkArtifact(input.client, {
			artifactId,
			workItemId: input.workItemId,
			workerRunId: input.workerRunId,
		});
		return {
			ok: true,
			commentId: created.id,
			commentUrl: created.htmlUrl,
		};
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export function buildIssueStatusCommentMarker(workItemId: string) {
	return `${ISSUE_STATUS_COMMENT_MARKER}${workItemId}${ISSUE_STATUS_COMMENT_MARKER_SUFFIX}`;
}

async function findExistingIssueStatusCommentArtifact(
	client: Client,
	workItemId: string,
): Promise<IssueStatusCommentArtifact | null> {
	const result = await client.execute({
		sql: `
			SELECT
				id,
				work_item_id,
				worker_run_id,
				kind,
				external_id,
				external_url,
				snapshot_json,
				metadata_json,
				created_at,
				updated_at
			FROM artifacts
			WHERE work_item_id = ? AND kind = ?
			ORDER BY created_at DESC
			LIMIT 1
		`,
		args: [workItemId, ISSUE_STATUS_COMMENT_KIND],
	});
	const row = result.rows[0];
	if (!row) {
		return null;
	}

	const typedRow = row as unknown as {
		id: string;
		work_item_id: string;
		worker_run_id: string | null;
		kind: string;
		external_id: string | null;
		external_url: string | null;
		snapshot_json: string | null;
		metadata_json: string | null;
		created_at: number;
		updated_at: number;
	};

	return {
		id: typedRow.id,
		workItemId: typedRow.work_item_id,
		workerRunId: typedRow.worker_run_id,
		kind: typedRow.kind as typeof ISSUE_STATUS_COMMENT_KIND,
		externalId: typedRow.external_id,
		externalUrl: typedRow.external_url,
		snapshot: typedRow.snapshot_json
			? JSON.parse(typedRow.snapshot_json)
			: null,
		metadata: typedRow.metadata_json ? JSON.parse(typedRow.metadata_json) : {},
		createdAt: typedRow.created_at,
		updatedAt: typedRow.updated_at,
	};
}

async function findReusableIssueStatusComment(input: {
	fetcher: typeof fetchIssueComments;
	owner: string;
	repository: string;
	issueNumber: number;
	workItemId: string;
}): Promise<GitHubIssueComment | null> {
	const comments = await input.fetcher({
		owner: input.owner,
		repository: input.repository,
		issueNumber: input.issueNumber,
	});
	const marker = buildIssueStatusCommentMarker(input.workItemId);
	return comments.find((comment) => comment.body.includes(marker)) ?? null;
}

async function maybeLinkArtifact(
	client: Client,
	input: {
		artifactId: string;
		workItemId: string;
		workerRunId: string | null | undefined;
	},
) {
	if (!input.workerRunId) {
		return;
	}

	await createLink(client, {
		workItemId: input.workItemId,
		fromNodeType: "worker_run",
		fromNodeId: input.workerRunId,
		toNodeType: "artifact",
		toNodeId: input.artifactId,
		relation: "posts",
		metadata: {
			origin: "issue-status-comment",
		},
	});
}

export function getIssueStatusCommentIntro(status: string | null) {
	if (status === "completed") {
		return "Rhapsody completed this issue.";
	}

	if (status === "failed") {
		return "Rhapsody needs attention.";
	}

	return "Rhapsody is working on this issue.";
}

function formatUtc(timestamp: number) {
	return new Date(timestamp)
		.toISOString()
		.replace("T", " ")
		.replace(".000Z", " UTC");
}

function escapeTableCell(value: string) {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}
