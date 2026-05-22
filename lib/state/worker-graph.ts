import type { Client } from "@libsql/client";
import type { Row } from "@libsql/client";

export type WorkerRunKind =
	| "intake_curator"
	| "builder"
	| "post_pr_curator"
	| "repairer"
	| "reviewer"
	| (string & {});

export type WorkerRunStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "canceled"
	| "timed_out"
	| "stale";

export type WorkerRun = {
	id: string;
	workItemId: string;
	kind: WorkerRunKind;
	status: WorkerRunStatus;
	claimToken: string | null;
	metadata: unknown;
	workItemSnapshot: unknown;
	createdAt: number;
	updatedAt: number;
	startedAt: number | null;
	finishedAt: number | null;
};

export type CreateWorkerRunInput = {
	workItemId: string;
	kind: WorkerRunKind;
	status?: WorkerRunStatus;
	claimToken?: string | null;
	metadata?: unknown;
	workItemSnapshot?: unknown;
	now?: number;
	id?: string;
};

export type CreatedWorkerRun = {
	id: string;
	status: WorkerRunStatus;
	kind: WorkerRunKind;
	createdAt: number;
};

export type UpdateWorkerRunStatusInput = {
	id: string;
	status: WorkerRunStatus;
	startedAt?: number | null;
	finishedAt?: number | null;
	now?: number;
};

export type UpdateWorkerRunStatusResult = {
	updated: boolean;
	workerRunId: string;
	status: WorkerRunStatus;
	updatedAt: number;
};

export type Decision = {
	id: string;
	workItemId: string;
	workerRunId: string;
	phase: string;
	outcome: string;
	deterministic: boolean;
	policyVersion: string | null;
	policyRuleId: string | null;
	evidence: unknown;
	nextWorkerKind: WorkerRunKind | null;
	nextAction: string | null;
	createdAt: number;
	updatedAt: number;
};

export type CreateDecisionInput = {
	workItemId: string;
	workerRunId: string;
	phase: string;
	outcome: string;
	deterministic?: boolean;
	policyVersion?: string | null;
	policyRuleId?: string | null;
	evidence?: unknown;
	nextWorkerKind?: WorkerRunKind | null;
	nextAction?: string | null;
	now?: number;
	id?: string;
};

export type Artifact = {
	id: string;
	workItemId: string;
	workerRunId: string | null;
	kind: string;
	externalId: string | null;
	externalUrl: string | null;
	snapshot: unknown;
	metadata: unknown;
	createdAt: number;
	updatedAt: number;
};

export type CreateArtifactInput = {
	workItemId: string;
	workerRunId?: string | null;
	kind: string;
	externalId?: string | null;
	externalUrl?: string | null;
	snapshot?: unknown;
	metadata?: unknown;
	now?: number;
	id?: string;
};

export type Link = {
	id: string;
	workItemId: string;
	fromNodeType: string;
	fromNodeId: string;
	toNodeType: string;
	toNodeId: string;
	relation: string;
	metadata: unknown;
	createdAt: number;
};

export type CreateLinkInput = {
	workItemId: string;
	fromNodeType: string;
	fromNodeId: string;
	toNodeType: string;
	toNodeId: string;
	relation: string;
	metadata?: unknown;
	now?: number;
	id?: string;
};

export type WorkItemGraph = {
	workItemId: string;
	workerRuns: WorkerRun[];
	decisions: Decision[];
	artifacts: Artifact[];
	links: Link[];
};

export async function createWorkerRun(
	client: Client,
	input: CreateWorkerRunInput,
): Promise<CreatedWorkerRun> {
	const now = input.now ?? Date.now();
	const id = input.id ?? createPrefixedId("wrn");
	const status = input.status ?? "pending";

	await client.execute({
		sql: `
			INSERT INTO worker_runs (
				id,
				work_item_id,
				kind,
				status,
				claim_token,
				metadata_json,
				work_item_snapshot_json,
				created_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			id,
			input.workItemId,
			input.kind,
			status,
			input.claimToken ?? null,
			JSON.stringify(input.metadata ?? {}),
			JSON.stringify(input.workItemSnapshot ?? {}),
			now,
			now,
		],
	});

	return {
		id,
		status,
		kind: input.kind,
		createdAt: now,
	};
}

export async function updateWorkerRunStatus(
	client: Client,
	input: UpdateWorkerRunStatusInput,
): Promise<UpdateWorkerRunStatusResult> {
	const now = input.now ?? Date.now();
	const isRunning = input.status === "running";
	const isTerminal =
		input.status === "completed" ||
		input.status === "failed" ||
		input.status === "canceled" ||
		input.status === "timed_out" ||
		input.status === "stale";
	const startedAt = input.startedAt ?? (isRunning ? now : null);
	const finishedAt = input.finishedAt ?? (isTerminal ? now : null);

	const result = await client.execute({
		sql: `
			UPDATE worker_runs
			SET
				status = ?,
				started_at = CASE
					WHEN ? IS NOT NULL THEN ?
					WHEN status IN ('pending', 'running') AND ? = 'running' THEN COALESCE(started_at, ?)
					ELSE started_at
				END,
				finished_at = CASE
					WHEN ? IS NOT NULL THEN ?
					WHEN status NOT IN ('completed', 'failed', 'canceled', 'timed_out', 'stale') AND ? IN ('completed', 'failed', 'canceled', 'timed_out', 'stale')
					THEN COALESCE(finished_at, ?)
					ELSE finished_at
				END,
				updated_at = ?
			WHERE id = ?
		`,
		args: [
			input.status,
			startedAt,
			startedAt,
			input.status,
			startedAt,
			finishedAt,
			finishedAt,
			input.status,
			finishedAt,
			now,
			input.id,
		],
	});

	if ((result.rowsAffected ?? 0) < 1) {
		return {
			updated: false,
			workerRunId: input.id,
			status: input.status,
			updatedAt: now,
		};
	}

	return {
		updated: true,
		workerRunId: input.id,
		status: input.status,
		updatedAt: now,
	};
}

export async function createDecision(
	client: Client,
	input: CreateDecisionInput,
): Promise<string> {
	const now = input.now ?? Date.now();
	const id = input.id ?? createPrefixedId("dec");

	await client.execute({
		sql: `
			INSERT INTO decisions (
				id,
				work_item_id,
				worker_run_id,
				phase,
				outcome,
				deterministic,
				policy_version,
				policy_rule_id,
				evidence_json,
				next_worker_kind,
				next_action,
				created_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			id,
			input.workItemId,
			input.workerRunId,
			input.phase,
			input.outcome,
			input.deterministic ? 1 : 0,
			input.policyVersion ?? null,
			input.policyRuleId ?? null,
			input.evidence === undefined ? null : JSON.stringify(input.evidence),
			input.nextWorkerKind ?? null,
			input.nextAction ?? null,
			now,
			now,
		],
	});

	return id;
}

export async function createArtifact(
	client: Client,
	input: CreateArtifactInput,
): Promise<string> {
	const now = input.now ?? Date.now();
	const id = input.id ?? createPrefixedId("art");

	await client.execute({
		sql: `
			INSERT INTO artifacts (
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
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			id,
			input.workItemId,
			input.workerRunId ?? null,
			input.kind,
			input.externalId ?? null,
			input.externalUrl ?? null,
			input.snapshot === undefined ? null : JSON.stringify(input.snapshot),
			JSON.stringify(input.metadata ?? {}),
			now,
			now,
		],
	});

	return id;
}

export async function createLink(
	client: Client,
	input: CreateLinkInput,
): Promise<string> {
	const now = input.now ?? Date.now();
	const id = input.id ?? createPrefixedId("lnk");

	await client.execute({
		sql: `
			INSERT INTO links (
				id,
				work_item_id,
				from_node_type,
				from_node_id,
				to_node_type,
				to_node_id,
				relation,
				metadata_json,
				created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			id,
			input.workItemId,
			input.fromNodeType,
			input.fromNodeId,
			input.toNodeType,
			input.toNodeId,
			input.relation,
			JSON.stringify(input.metadata ?? {}),
			now,
		],
	});

	return id;
}

export async function listWorkItemGraph(
	client: Client,
	workItemId: string,
): Promise<WorkItemGraph> {
	const [runsResult, decisionsResult, artifactsResult, linksResult] =
		await Promise.all([
			client.execute({
				sql: `
				SELECT
					id,
					work_item_id,
					kind,
					status,
					claim_token,
					metadata_json,
					work_item_snapshot_json,
					created_at,
					updated_at,
					started_at,
					finished_at
				FROM worker_runs
				WHERE work_item_id = ?
				ORDER BY created_at DESC
			`,
				args: [workItemId],
			}),
			client.execute({
				sql: `
				SELECT
					id,
					work_item_id,
					worker_run_id,
					phase,
					outcome,
					deterministic,
					policy_version,
					policy_rule_id,
					evidence_json,
					next_worker_kind,
					next_action,
					created_at,
					updated_at
				FROM decisions
				WHERE work_item_id = ?
				ORDER BY created_at DESC
			`,
				args: [workItemId],
			}),
			client.execute({
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
				WHERE work_item_id = ?
				ORDER BY created_at DESC
			`,
				args: [workItemId],
			}),
			client.execute({
				sql: `
				SELECT
					id,
					work_item_id,
					from_node_type,
					from_node_id,
					to_node_type,
					to_node_id,
					relation,
					metadata_json,
					created_at
				FROM links
				WHERE work_item_id = ?
				ORDER BY created_at ASC
			`,
				args: [workItemId],
			}),
		]);

	return {
		workItemId,
		workerRuns: runsResult.rows.map(mapWorkerRun),
		decisions: decisionsResult.rows.map(mapDecision),
		artifacts: artifactsResult.rows.map(mapArtifact),
		links: linksResult.rows.map(mapLink),
	};
}

const mapWorkerRun = (row: Row): WorkerRun => ({
	id: getString(row, "id"),
	workItemId: getString(row, "work_item_id"),
	kind: getString(row, "kind") as WorkerRunKind,
	status: getString(row, "status") as WorkerRunStatus,
	claimToken: getNullableString(row, "claim_token"),
	metadata: parseJsonValue(getString(row, "metadata_json")),
	workItemSnapshot: parseJsonValue(getString(row, "work_item_snapshot_json")),
	createdAt: getNumber(row, "created_at"),
	updatedAt: getNumber(row, "updated_at"),
	startedAt: getNullableNumber(row, "started_at"),
	finishedAt: getNullableNumber(row, "finished_at"),
});

const mapDecision = (row: Row): Decision => ({
	id: getString(row, "id"),
	workItemId: getString(row, "work_item_id"),
	workerRunId: getString(row, "worker_run_id"),
	phase: getString(row, "phase"),
	outcome: getString(row, "outcome"),
	deterministic: getBoolean(row, "deterministic"),
	policyVersion: getNullableString(row, "policy_version"),
	policyRuleId: getNullableString(row, "policy_rule_id"),
	evidence: parseNullableJsonValue(getNullableString(row, "evidence_json")),
	nextWorkerKind: getNullableString(
		row,
		"next_worker_kind",
	) as WorkerRunKind | null,
	nextAction: getNullableString(row, "next_action"),
	createdAt: getNumber(row, "created_at"),
	updatedAt: getNumber(row, "updated_at"),
});

const mapArtifact = (row: Row): Artifact => ({
	id: getString(row, "id"),
	workItemId: getString(row, "work_item_id"),
	workerRunId: getNullableString(row, "worker_run_id"),
	kind: getString(row, "kind"),
	externalId: getNullableString(row, "external_id"),
	externalUrl: getNullableString(row, "external_url"),
	snapshot: parseNullableJsonValue(getNullableString(row, "snapshot_json")),
	metadata: parseJsonValue(getString(row, "metadata_json")),
	createdAt: getNumber(row, "created_at"),
	updatedAt: getNumber(row, "updated_at"),
});

const mapLink = (row: Row): Link => ({
	id: getString(row, "id"),
	workItemId: getString(row, "work_item_id"),
	fromNodeType: getString(row, "from_node_type"),
	fromNodeId: getString(row, "from_node_id"),
	toNodeType: getString(row, "to_node_type"),
	toNodeId: getString(row, "to_node_id"),
	relation: getString(row, "relation"),
	metadata: parseJsonValue(getString(row, "metadata_json")),
	createdAt: getNumber(row, "created_at"),
});

const createPrefixedId = (prefix: "wrn" | "dec" | "art" | "lnk") => {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
};

function getString(row: Row | undefined, column: string): string {
	const value = row?.[column];

	if (typeof value !== "string") {
		throw new Error(`Expected ${column} to be a string.`);
	}

	return value;
}

function getNullableString(row: Row, column: string): string | null {
	const value = row[column];

	if (value === null) {
		return null;
	}

	if (typeof value !== "string") {
		throw new Error(`Expected ${column} to be a string or null.`);
	}

	return value;
}

function getNumber(row: Row | undefined, column: string): number {
	const value = row?.[column];

	if (typeof value !== "number") {
		throw new Error(`Expected ${column} to be a number.`);
	}

	return value;
}

function getNullableNumber(row: Row, column: string): number | null {
	const value = row[column];

	if (value === null) {
		return null;
	}

	if (typeof value !== "number") {
		throw new Error(`Expected ${column} to be a number or null.`);
	}

	return value;
}

function getBoolean(row: Row, column: string): boolean {
	const value = row[column];

	if (typeof value === "boolean") {
		return value;
	}

	if (typeof value === "number") {
		return value === 1;
	}

	throw new Error(`Expected ${column} to be a boolean or 1/0.`);
}

function parseJsonValue(value: string): unknown {
	return JSON.parse(value);
}

function parseNullableJsonValue(value: string | null): unknown {
	return value === null ? null : JSON.parse(value);
}
