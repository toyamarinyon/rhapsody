import type { Client } from "@libsql/client";

import {
	getRunDetail,
	getStateSummary,
	listWorkItemGraph,
	type RunDetail,
	type StateStoreAttempt,
	type StateStoreEvent,
	type StateSummary,
	type WorkItemGraph,
} from "@/lib/state";

export type DashboardAttentionItem = {
	runId: string;
	workItemId: string;
	workItemTitle: string;
	workItemUrl: string | null;
	status: string;
	runner: string;
	attemptCount: number;
	updatedAt: number;
	claimExpiresAt: number | null;
	claimIsActive: boolean;
	attentionReason: string;
	lastEventType: string | null;
	lastEventMessage: string | null;
};

export type DashboardActivityItem = {
	runId: string;
	workItemId: string;
	workItemTitle: string;
	workItemUrl: string | null;
	status: string;
	runner: string;
	attemptCount: number;
	updatedAt: number;
	lastAttemptStatus: string | null;
	lastEventLevel: string | null;
	lastEventType: string | null;
	lastEventMessage: string | null;
};

export type DashboardProjection = {
	stateSummary: StateSummary;
	attentionItems: DashboardAttentionItem[];
	recentActivity: DashboardActivityItem[];
};

export type WorkItemDiagnosticsProjection = {
	workItemId: string;
	github: {
		title: string | null;
		url: string | null;
		status: string | null;
		projectStatus: string | null;
		issueState: string | null;
		issueNumber: number | null;
		latestPrUrl: string | null;
		latestCommentUrl: string | null;
		snapshot: unknown;
	};
	rhapsody: {
		latestRun: {
			id: string;
			status: string;
			runner: string;
			updatedAt: number;
			workItemUrl: string | null;
			attemptCount: number;
			lastAttemptStatus: string | null;
			lastEventLevel: string | null;
			lastEventType: string | null;
			lastEventMessage: string | null;
			failurePoint: string | null;
			lastError: string | null;
		} | null;
		latestAttempt: {
			id: string;
			status: string;
			exitCode: number | null;
			command: string | null;
			sandboxId: string | null;
			startedAt: number | null;
			finishedAt: number | null;
		} | null;
		latestDecision: {
			id: string;
			phase: string;
			outcome: string;
			nextAction: string | null;
			nextWorkerKind: string | null;
			createdAt: number;
		} | null;
		activeClaim: {
			claimToken: string;
			claimedBy: string;
			runId: string | null;
			expiresAt: number;
		} | null;
		summary: {
			workerRuns: number;
			decisions: number;
			artifacts: number;
			links: number;
			sandboxSessions: number;
		};
		runs: Array<{
			id: string;
			status: string;
			runner: string;
			updatedAt: number;
			attemptCount: number;
			lastAttemptStatus: string | null;
			lastEventLevel: string | null;
			lastEventType: string | null;
			lastEventMessage: string | null;
		}>;
	};
	graph: WorkItemGraph;
};

export type RunDiagnosticsProjection = {
	detail: RunDetail;
	artifacts: Array<{
		kind: string;
		externalUrl: string | null;
		externalId: string | null;
		workerRunId: string | null;
		createdAt: number;
	}>;
	workItem: {
		id: string;
		title: string;
		url: string | null;
		status: string | null;
		issueState: string | null;
		projectStatus: string | null;
		issueNumber: number | null;
		snapshot: unknown;
	};
	summary: {
		status: string;
		runner: string;
		attemptCount: number;
		eventCount: number;
		sandboxSessionCount: number;
		lastMeaningfulError: string | null;
		failurePoint: string | null;
		lastAttemptStatus: string | null;
		lastEventType: string | null;
		lastEventMessage: string | null;
		branchEvidence: string | null;
	};
	timeline: Array<{
		createdAt: number;
		level: string;
		type: string;
		message: string | null;
	}>;
	attempts: Array<{
		id: string;
		attemptNumber: number;
		status: string;
		command: string | null;
		sandboxId: string | null;
		exitCode: number | null;
		startedAt: number | null;
		finishedAt: number | null;
	}>;
};

type RunRow = {
	id: string;
	work_item_id: string;
	work_item_title: string;
	work_item_url: string | null;
	work_item_status: string | null;
	runner: string;
	status: string;
	updated_at: number;
	claim_expires_at: number | null;
	attempt_count: number;
	last_attempt_status: string | null;
	last_event_level: string | null;
	last_event_type: string | null;
	last_event_message: string | null;
};

type WorkItemRunRow = RunRow & {
	work_item_snapshot_json: string;
};

export async function loadDashboardProjection(
	client: Client,
	now = Date.now(),
): Promise<DashboardProjection> {
	const [stateSummary, runRows] = await Promise.all([
		getStateSummary(client, now),
		listRecentRuns(client),
	]);

	return {
		stateSummary,
		attentionItems: runRows
			.filter((row) => isAttentionItem(row, now))
			.map((row) => toAttentionItem(row, now))
			.slice(0, 8),
		recentActivity: runRows.slice(0, 10).map(toActivityItem),
	};
}

export async function loadWorkItemDiagnosticsProjection(
	client: Client,
	workItemId: string,
	now = Date.now(),
): Promise<WorkItemDiagnosticsProjection> {
	const [graph, runRows, activeClaimRow] = await Promise.all([
		listWorkItemGraph(client, workItemId),
		listWorkItemRuns(client, workItemId),
		loadActiveClaimRow(client, workItemId, now),
	]);

	const latestRun = runRows[0] ?? null;
	const latestRunDetail = latestRun
		? await getRunDetail(client, latestRun.id)
		: null;
	const latestSnapshot = latestRun
		? readSnapshot(latestRun.work_item_snapshot_json)
		: null;
	const latestFailureEvent = latestRunDetail
		? findLastMeaningfulEvent(latestRunDetail.events)
		: null;
	const latestAttempt = latestRunDetail?.attempts.at(-1) ?? null;
	const latestDecision = graph.decisions[0] ?? null;
	const latestCommentArtifact = getLatestArtifact(graph, [
		"intake_comment",
		"repair_blocked_comment",
		"issue_status_comment",
	]);
	const latestPrArtifact = getLatestArtifact(graph, ["pull_request"]);
	const github = extractGitHubWorkItem(
		latestSnapshot,
		latestRun?.work_item_title ?? null,
		latestRun?.work_item_url ?? null,
		latestRun?.work_item_status ?? null,
	);

	return {
		workItemId,
		github: {
			...github,
			latestPrUrl: latestPrArtifact?.externalUrl ?? null,
			latestCommentUrl: latestCommentArtifact?.externalUrl ?? null,
		},
		rhapsody: {
			latestRun: latestRun
				? {
						id: latestRun.id,
						status: latestRun.status,
						runner: latestRun.runner,
						updatedAt: latestRun.updated_at,
						workItemUrl: latestRun.work_item_url,
						attemptCount: latestRun.attempt_count,
						lastAttemptStatus: latestRun.last_attempt_status,
						lastEventLevel: latestRun.last_event_level,
						lastEventType: latestRun.last_event_type,
						lastEventMessage: latestRun.last_event_message,
						failurePoint: latestFailureEvent?.type ?? null,
						lastError: latestFailureEvent?.message ?? null,
					}
				: null,
			latestAttempt: latestAttempt
				? {
						id: latestAttempt.id,
						status: latestAttempt.status,
						exitCode: latestAttempt.exitCode,
						command: latestAttempt.command,
						sandboxId: latestAttempt.sandboxId,
						startedAt: latestAttempt.startedAt,
						finishedAt: latestAttempt.finishedAt,
					}
				: null,
			latestDecision: latestDecision
				? {
						id: latestDecision.id,
						phase: latestDecision.phase,
						outcome: latestDecision.outcome,
						nextAction: latestDecision.nextAction,
						nextWorkerKind: latestDecision.nextWorkerKind,
						createdAt: latestDecision.createdAt,
					}
				: null,
			activeClaim: activeClaimRow,
			summary: {
				workerRuns: graph.workerRuns.length,
				decisions: graph.decisions.length,
				artifacts: graph.artifacts.length,
				links: graph.links.length,
				sandboxSessions: graph.sandboxSessions.length,
			},
			runs: runRows.map((run) => ({
				id: run.id,
				status: run.status,
				runner: run.runner,
				updatedAt: run.updated_at,
				attemptCount: run.attempt_count,
				lastAttemptStatus: run.last_attempt_status,
				lastEventLevel: run.last_event_level,
				lastEventType: run.last_event_type,
				lastEventMessage: run.last_event_message,
			})),
		},
		graph,
	};
}

export async function loadRunDiagnosticsProjection(
	client: Client,
	runId: string,
): Promise<RunDiagnosticsProjection | null> {
	const detail = await getRunDetail(client, runId);

	if (!detail) {
		return null;
	}

	const latestAttempt = detail.attempts.at(-1) ?? null;
	const latestEvent = detail.events.at(-1) ?? null;
	const latestFailureEvent = findLastMeaningfulEvent(detail.events);
	const workItemSnapshot = readSnapshot(detail.run.workItemSnapshot);
	const graph = await listWorkItemGraph(client, detail.run.workItemId);
	const github = extractGitHubWorkItem(
		workItemSnapshot,
		detail.run.workItemTitle,
		detail.run.workItemUrl,
		detail.run.workItemStatus,
	);

	return {
		detail,
		artifacts: graph.artifacts.map((artifact) => ({
			kind: artifact.kind,
			externalUrl: artifact.externalUrl,
			externalId: artifact.externalId,
			workerRunId: artifact.workerRunId,
			createdAt: artifact.createdAt,
		})),
		workItem: {
			id: detail.run.workItemId,
			title: github.title ?? detail.run.workItemTitle,
			url: github.url ?? detail.run.workItemUrl,
			status: github.status ?? detail.run.workItemStatus,
			issueState: github.issueState,
			projectStatus: github.projectStatus,
			issueNumber: github.issueNumber,
			snapshot: workItemSnapshot,
		},
		summary: {
			status: detail.run.status,
			runner: detail.run.runner,
			attemptCount: detail.attempts.length,
			eventCount: detail.events.length,
			sandboxSessionCount: detail.sandboxSessions.length,
			lastMeaningfulError: latestFailureEvent?.message ?? null,
			failurePoint:
				latestFailureEvent?.type ??
				(isAttentionStatus(detail.run.status) ? detail.run.status : null),
			lastAttemptStatus: latestAttempt?.status ?? null,
			lastEventType: latestEvent?.type ?? null,
			lastEventMessage: latestEvent?.message ?? null,
			branchEvidence: extractBranchEvidence(detail.attempts, graph.artifacts),
		},
		timeline: detail.events.map((event) => ({
			createdAt: event.createdAt,
			level: event.level,
			type: event.type,
			message: event.message,
		})),
		attempts: detail.attempts.map((attempt) => ({
			id: attempt.id,
			attemptNumber: attempt.attemptNumber,
			status: attempt.status,
			command: attempt.command,
			sandboxId: attempt.sandboxId,
			exitCode: attempt.exitCode,
			startedAt: attempt.startedAt,
			finishedAt: attempt.finishedAt,
		})),
	};
}

async function listRecentRuns(client: Client): Promise<RunRow[]> {
	const result = await client.execute({
		sql: `
			SELECT
				runs.id,
				runs.work_item_id,
				runs.work_item_title,
				runs.work_item_url,
				runs.work_item_status,
				runs.runner,
				runs.status,
				runs.updated_at,
				claims.claim_expires_at,
				(
					SELECT COUNT(*)
					FROM attempts
					WHERE attempts.run_id = runs.id
				) AS attempt_count,
				(
					SELECT attempts.status
					FROM attempts
					WHERE attempts.run_id = runs.id
					ORDER BY attempts.attempt_number DESC
					LIMIT 1
				) AS last_attempt_status,
				(
					SELECT events.level
					FROM events
					WHERE events.run_id = runs.id
					ORDER BY events.created_at DESC
					LIMIT 1
				) AS last_event_level,
				(
					SELECT events.type
					FROM events
					WHERE events.run_id = runs.id
					ORDER BY events.created_at DESC
					LIMIT 1
				) AS last_event_type,
				(
					SELECT events.message
					FROM events
					WHERE events.run_id = runs.id
					ORDER BY events.created_at DESC
					LIMIT 1
				) AS last_event_message
			FROM runs
			LEFT JOIN claims
				ON claims.run_id = runs.id
			ORDER BY runs.updated_at DESC
			LIMIT 20
		`,
	});

	return result.rows.map(mapRunRow);
}

async function listWorkItemRuns(
	client: Client,
	workItemId: string,
): Promise<WorkItemRunRow[]> {
	const result = await client.execute({
		sql: `
			SELECT
				runs.id,
				runs.work_item_id,
				runs.work_item_title,
				runs.work_item_url,
				runs.work_item_status,
				runs.runner,
				runs.status,
				runs.updated_at,
				NULL AS claim_expires_at,
				runs.work_item_snapshot_json,
				(
					SELECT COUNT(*)
					FROM attempts
					WHERE attempts.run_id = runs.id
				) AS attempt_count,
				(
					SELECT attempts.status
					FROM attempts
					WHERE attempts.run_id = runs.id
					ORDER BY attempts.attempt_number DESC
					LIMIT 1
				) AS last_attempt_status,
				(
					SELECT events.level
					FROM events
					WHERE events.run_id = runs.id
					ORDER BY events.created_at DESC
					LIMIT 1
				) AS last_event_level,
				(
					SELECT events.type
					FROM events
					WHERE events.run_id = runs.id
					ORDER BY events.created_at DESC
					LIMIT 1
				) AS last_event_type,
				(
					SELECT events.message
					FROM events
					WHERE events.run_id = runs.id
					ORDER BY events.created_at DESC
					LIMIT 1
				) AS last_event_message
			FROM runs
			WHERE runs.work_item_id = ?
			ORDER BY runs.updated_at DESC
		`,
		args: [workItemId],
	});

	return result.rows.map((row) => ({
		...mapRunRow(row),
		work_item_snapshot_json: asString(row.work_item_snapshot_json),
	}));
}

async function loadActiveClaimRow(
	client: Client,
	workItemId: string,
	now: number,
): Promise<WorkItemDiagnosticsProjection["rhapsody"]["activeClaim"]> {
	const result = await client.execute({
		sql: `
			SELECT
				claim_token,
				claimed_by,
				run_id,
				claim_expires_at
			FROM claims
			WHERE work_item_id = ? AND claim_expires_at > ?
			ORDER BY claim_expires_at DESC
			LIMIT 1
		`,
		args: [workItemId, now],
	});
	const row = result.rows[0];

	if (!row) {
		return null;
	}

	return {
		claimToken: asString(row.claim_token),
		claimedBy: asString(row.claimed_by),
		runId: asNullableString(row.run_id),
		expiresAt: asNumber(row.claim_expires_at),
	};
}

function mapRunRow(row: Record<string, unknown>): RunRow {
	return {
		id: asString(row.id),
		work_item_id: asString(row.work_item_id),
		work_item_title: asString(row.work_item_title),
		work_item_url: asNullableString(row.work_item_url),
		work_item_status: asNullableString(row.work_item_status),
		runner: asString(row.runner),
		status: asString(row.status),
		updated_at: asNumber(row.updated_at),
		claim_expires_at: asNullableNumber(row.claim_expires_at),
		attempt_count: asNumber(row.attempt_count),
		last_attempt_status: asNullableString(row.last_attempt_status),
		last_event_level: asNullableString(row.last_event_level),
		last_event_type: asNullableString(row.last_event_type),
		last_event_message: asNullableString(row.last_event_message),
	};
}

function toAttentionItem(row: RunRow, now: number): DashboardAttentionItem {
	const claimIsActive =
		row.claim_expires_at !== null && row.claim_expires_at > now;

	return {
		runId: row.id,
		workItemId: row.work_item_id,
		workItemTitle: row.work_item_title,
		workItemUrl: row.work_item_url,
		status: row.status,
		runner: row.runner,
		attemptCount: row.attempt_count,
		updatedAt: row.updated_at,
		claimExpiresAt: row.claim_expires_at,
		claimIsActive,
		attentionReason:
			row.claim_expires_at !== null && row.claim_expires_at <= now
				? "claim stale"
				: claimIsActive
					? "expiring claim"
					: isAttentionStatus(row.status)
						? `run ${row.status}`
						: row.last_event_level === "error"
							? "recent error event"
							: "recent warning event",
		lastEventType: row.last_event_type,
		lastEventMessage: row.last_event_message,
	};
}

function toActivityItem(row: RunRow): DashboardActivityItem {
	return {
		runId: row.id,
		workItemId: row.work_item_id,
		workItemTitle: row.work_item_title,
		workItemUrl: row.work_item_url,
		status: row.status,
		runner: row.runner,
		attemptCount: row.attempt_count,
		updatedAt: row.updated_at,
		lastAttemptStatus: row.last_attempt_status,
		lastEventLevel: row.last_event_level,
		lastEventType: row.last_event_type,
		lastEventMessage: row.last_event_message,
	};
}

function isAttentionStatus(status: string): boolean {
	return status === "failed" || status === "timed_out" || status === "stale";
}

function isAttentionItem(row: RunRow, now: number): boolean {
	if (isAttentionStatus(row.status)) {
		return true;
	}

	if (
		row.claim_expires_at !== null &&
		row.claim_expires_at <= now + 15 * 60 * 1000
	) {
		return true;
	}

	return row.last_event_level === "error" || row.last_event_level === "warn";
}

function extractGitHubWorkItem(
	snapshot: unknown,
	fallbackTitle: string | null,
	fallbackUrl: string | null,
	fallbackStatus: string | null,
): {
	title: string | null;
	url: string | null;
	status: string | null;
	projectStatus: string | null;
	issueState: string | null;
	issueNumber: number | null;
	snapshot: unknown;
} {
	const record = asRecord(snapshot);
	const issue = asRecord(record?.issue ?? record?.githubIssue ?? record?.item);

	return {
		title:
			asNullableString(issue?.title) ??
			asNullableString(record?.title) ??
			fallbackTitle,
		url:
			asNullableString(issue?.url) ??
			asNullableString(issue?.htmlUrl) ??
			asNullableString(record?.url) ??
			fallbackUrl,
		status:
			asNullableString(issue?.status) ??
			asNullableString(record?.status) ??
			fallbackStatus,
		projectStatus: readGithubProjectStatus(snapshot),
		issueState: readGithubIssueState(snapshot),
		issueNumber: asNullableNumber(issue?.number ?? record?.issueNumber),
		snapshot,
	};
}

function readGithubProjectStatus(snapshot: unknown): string | null {
	const record = asRecord(snapshot);
	const project = asRecord(record?.project);

	return (
		asNullableString(record?.projectStatus) ??
		asNullableString(project?.status) ??
		asNullableString(record?.projectItemStatus)
	);
}

function readGithubIssueState(snapshot: unknown): string | null {
	const record = asRecord(snapshot);
	const issue = asRecord(record?.issue);

	return (
		asNullableString(record?.issueState) ??
		asNullableString(issue?.state) ??
		asNullableString(record?.state)
	);
}

function getLatestArtifact(graph: WorkItemGraph, kinds: string[]) {
	return (
		graph.artifacts
			.filter((artifact) => kinds.includes(artifact.kind))
			.sort((left, right) => right.createdAt - left.createdAt)[0] ?? null
	);
}

function findLastMeaningfulEvent(
	events: readonly StateStoreEvent[],
): StateStoreEvent | null {
	return (
		[...events]
			.reverse()
			.find(
				(event) =>
					event.level === "error" ||
					event.level === "warn" ||
					event.type.includes("failed") ||
					event.type.includes("timed_out") ||
					event.type.includes("stale"),
			) ?? null
	);
}

function extractBranchEvidence(
	attempts: readonly StateStoreAttempt[],
	artifacts: readonly WorkItemGraph["artifacts"][number][],
): string | null {
	const latestAttempt = attempts.at(-1) ?? null;
	const branchArtifact = artifacts
		.filter((artifact) => artifact.kind === "branch")
		.sort((left, right) => right.createdAt - left.createdAt)[0];
	const commitArtifact = artifacts
		.filter((artifact) => artifact.kind === "commit")
		.sort((left, right) => right.createdAt - left.createdAt)[0];

	return (
		branchArtifact?.externalUrl ??
		branchArtifact?.externalId ??
		commitArtifact?.externalUrl ??
		latestAttempt?.gitBranchName ??
		null
	);
}

function readSnapshot(value: unknown): unknown {
	if (typeof value === "string") {
		try {
			return JSON.parse(value) as unknown;
		} catch {
			return value;
		}
	}

	return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : String(value ?? "");
}

function asNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
	return typeof value === "number" ? value : Number(value ?? 0);
}

function asNullableNumber(value: unknown): number | null {
	return typeof value === "number" ? value : null;
}
