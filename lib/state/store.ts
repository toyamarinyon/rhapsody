import type { Client } from "@libsql/client";
import type { Row } from "@libsql/client";

export type RunStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "canceled"
	| "timed_out"
	| "stale";
export type AttemptStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "canceled"
	| "timed_out"
	| "stale";
export type EventLevel = "debug" | "info" | "warn" | "error";

export type CreateManualRunInput = {
	workItemId: string;
	claimToken: string;
	workItemTitle: string;
	workItemUrl?: string | null;
	workItemStatus?: string | null;
	workItemSnapshot?: unknown;
	status?: RunStatus;
	now?: number;
	id?: string;
};

export type CreateAttemptInput = {
	runId: string;
	attemptNumber: number;
	status?: AttemptStatus;
	sandboxId?: string | null;
	command?: string | null;
	now?: number;
	id?: string;
};

export type CreateEventInput = {
	runId?: string | null;
	attemptId?: string | null;
	level?: EventLevel;
	type: string;
	message?: string | null;
	data?: unknown;
	now?: number;
	id?: string;
};

export type CreateClaimedManualRunInput = {
	workItemId: string;
	workItemTitle: string;
	workItemUrl?: string | null;
	workItemStatus?: string | null;
	workItemSnapshot?: unknown;
	claimedBy: string;
	claimTtlMs: number;
	now?: number;
	claimToken?: string;
	runId?: string;
	attemptId?: string;
	eventId?: string;
};

export type CreatedRun = {
	id: string;
	status: RunStatus;
	createdAt: number;
};

export type CreatedAttempt = {
	id: string;
	status: AttemptStatus;
	createdAt: number;
};

export type CreatedEvent = {
	id: string;
	level: EventLevel;
	createdAt: number;
};

export type ClaimedManualRunCreated = {
	acquired: true;
	claimToken: string;
	claimExpiresAt: number;
	runId: string;
	attemptId: string;
	eventId: string;
	createdAt: number;
};

export type ClaimedManualRunNotAcquired = {
	acquired: false;
	existingRunId: string | null;
	claimExpiresAt: number;
};

export type CreateClaimedManualRunResult = ClaimedManualRunCreated | ClaimedManualRunNotAcquired;

export type StateStoreRun = {
	id: string;
	workItemId: string;
	claimToken: string;
	status: RunStatus;
	workItemTitle: string;
	workItemUrl: string | null;
	workItemStatus: string | null;
	workItemSnapshot: unknown;
	createdAt: number;
	updatedAt: number;
	startedAt: number | null;
	finishedAt: number | null;
};

export type StateStoreAttempt = {
	id: string;
	runId: string;
	attemptNumber: number;
	status: AttemptStatus;
	sandboxId: string | null;
	command: string | null;
	exitCode: number | null;
	createdAt: number;
	updatedAt: number;
	startedAt: number | null;
	finishedAt: number | null;
};

export type StateStoreEvent = {
	id: string;
	runId: string | null;
	attemptId: string | null;
	level: EventLevel;
	type: string;
	message: string | null;
	data: unknown;
	createdAt: number;
};

export type StateStoreClaim = {
	workItemId: string;
	claimToken: string;
	claimedBy: string;
	runId: string | null;
	workItemStatus: string | null;
	claimExpiresAt: number;
	createdAt: number;
	updatedAt: number;
};

export type RunDetail = {
	run: StateStoreRun;
	attempts: StateStoreAttempt[];
	events: StateStoreEvent[];
	claim: StateStoreClaim | null;
};

export type StateSummary = {
	runStatusCounts: Record<string, number>;
	attemptStatusCounts: Record<string, number>;
	activeClaimCount: number;
	recentEvents: StateStoreEvent[];
};

export async function getRunDetail(client: Client, runId: string): Promise<RunDetail | null> {
	const runResult = await client.execute({
		sql: `
			SELECT
				id,
				work_item_id,
				claim_token,
				status,
				work_item_title,
				work_item_url,
				work_item_status,
				work_item_snapshot_json,
				created_at,
				updated_at,
				started_at,
				finished_at
			FROM runs
			WHERE id = ?
		`,
		args: [runId],
	});
	const runRow = runResult.rows[0];

	if (!runRow) {
		return null;
	}

	const run = mapRun(runRow);
	const [attemptsResult, eventsResult, claimResult] = await Promise.all([
		client.execute({
			sql: `
				SELECT
					id,
					run_id,
					attempt_number,
					status,
					sandbox_id,
					command,
					exit_code,
					created_at,
					updated_at,
					started_at,
					finished_at
				FROM attempts
				WHERE run_id = ?
				ORDER BY attempt_number ASC
			`,
			args: [runId],
		}),
		client.execute({
			sql: `
				SELECT
					id,
					run_id,
					attempt_id,
					level,
					type,
					message,
					data_json,
					created_at
				FROM events
				WHERE run_id = ?
				ORDER BY created_at ASC
			`,
			args: [runId],
		}),
		client.execute({
			sql: `
				SELECT
					work_item_id,
					claim_token,
					claimed_by,
					run_id,
					work_item_status,
					claim_expires_at,
					created_at,
					updated_at
				FROM claims
				WHERE run_id = ? OR work_item_id = ?
				ORDER BY CASE WHEN run_id = ? THEN 0 ELSE 1 END
				LIMIT 1
			`,
			args: [runId, run.workItemId, runId],
		}),
	]);

	return {
		run,
		attempts: attemptsResult.rows.map(mapAttempt),
		events: eventsResult.rows.map(mapEvent),
		claim: claimResult.rows[0] ? mapClaim(claimResult.rows[0]) : null,
	};
}

export async function getStateSummary(client: Client, now = Date.now()): Promise<StateSummary> {
	const [runCountsResult, attemptCountsResult, activeClaimsResult, recentEventsResult] = await Promise.all([
		client.execute(`
			SELECT status, COUNT(*) AS count
			FROM runs
			GROUP BY status
			ORDER BY status ASC
		`),
		client.execute(`
			SELECT status, COUNT(*) AS count
			FROM attempts
			GROUP BY status
			ORDER BY status ASC
		`),
		client.execute({
			sql: `
				SELECT COUNT(*) AS count
				FROM claims
				WHERE claim_expires_at > ?
			`,
			args: [now],
		}),
		client.execute(`
			SELECT
				id,
				run_id,
				attempt_id,
				level,
				type,
				message,
				data_json,
				created_at
			FROM events
			ORDER BY created_at DESC
			LIMIT 20
		`),
	]);

	return {
		runStatusCounts: mapCountRows(runCountsResult.rows),
		attemptStatusCounts: mapCountRows(attemptCountsResult.rows),
		activeClaimCount: getNumber(activeClaimsResult.rows[0], "count"),
		recentEvents: recentEventsResult.rows.map(mapEvent),
	};
}

export async function createClaimedManualRun(
	client: Client,
	input: CreateClaimedManualRunInput,
): Promise<CreateClaimedManualRunResult> {
	const now = input.now ?? Date.now();
	const claimExpiresAt = now + input.claimTtlMs;
	const claimToken = input.claimToken ?? createPrefixedId("claim");
	const runId = input.runId ?? createPrefixedId("run");
	const attemptId = input.attemptId ?? createPrefixedId("att");
	const eventId = input.eventId ?? createPrefixedId("evt");
	const workItemSnapshotJson = JSON.stringify(input.workItemSnapshot ?? {});
	const tx = await client.transaction("write");

	try {
		const existingClaim = await tx.execute({
			sql: `
				SELECT run_id, claim_expires_at
				FROM claims
				WHERE work_item_id = ?
			`,
			args: [input.workItemId],
		});
		const existingClaimRow = existingClaim.rows[0];

		if (existingClaimRow && Number(existingClaimRow.claim_expires_at) > now) {
			await tx.commit();
			return {
				acquired: false,
				existingRunId: typeof existingClaimRow.run_id === "string" ? existingClaimRow.run_id : null,
				claimExpiresAt: Number(existingClaimRow.claim_expires_at),
			};
		}

		await tx.execute({
			sql: `
				INSERT INTO claims (
					work_item_id,
					claim_token,
					claimed_by,
					run_id,
					work_item_status,
					claim_expires_at,
					created_at,
					updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
				ON CONFLICT (work_item_id) DO UPDATE SET
					claim_token = excluded.claim_token,
					claimed_by = excluded.claimed_by,
					run_id = excluded.run_id,
					work_item_status = excluded.work_item_status,
					claim_expires_at = excluded.claim_expires_at,
					created_at = excluded.created_at,
					updated_at = excluded.updated_at
			`,
			args: [
				input.workItemId,
				claimToken,
				input.claimedBy,
				runId,
				input.workItemStatus ?? null,
				claimExpiresAt,
				now,
				now,
			],
		});

		await tx.execute({
			sql: `
				INSERT INTO runs (
					id,
					work_item_id,
					claim_token,
					status,
					work_item_title,
					work_item_url,
					work_item_status,
					work_item_snapshot_json,
					created_at,
					updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
			args: [
				runId,
				input.workItemId,
				claimToken,
				"pending",
				input.workItemTitle,
				input.workItemUrl ?? null,
				input.workItemStatus ?? null,
				workItemSnapshotJson,
				now,
				now,
			],
		});

		await tx.execute({
			sql: `
				INSERT INTO attempts (
					id,
					run_id,
					attempt_number,
					status,
					created_at,
					updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?)
			`,
			args: [attemptId, runId, 1, "pending", now, now],
		});

		await tx.execute({
			sql: `
				INSERT INTO events (
					id,
					run_id,
					attempt_id,
					level,
					type,
					message,
					data_json,
					created_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			`,
			args: [
				eventId,
				runId,
				attemptId,
				"info",
				"manual_run.created",
				"Manual run created.",
				JSON.stringify({ workItemId: input.workItemId, claimedBy: input.claimedBy }),
				now,
			],
		});

		await tx.commit();

		return {
			acquired: true,
			claimToken,
			claimExpiresAt,
			runId,
			attemptId,
			eventId,
			createdAt: now,
		};
	} catch (error) {
		await tx.rollback();
		throw error;
	} finally {
		tx.close();
	}
}

export async function createManualRun(
	client: Client,
	input: CreateManualRunInput,
): Promise<CreatedRun> {
	const now = input.now ?? Date.now();
	const id = input.id ?? createPrefixedId("run");
	const status = input.status ?? "pending";

	await client.execute({
		sql: `
			INSERT INTO runs (
				id,
				work_item_id,
				claim_token,
				status,
				work_item_title,
				work_item_url,
				work_item_status,
				work_item_snapshot_json,
				created_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			id,
			input.workItemId,
			input.claimToken,
			status,
			input.workItemTitle,
			input.workItemUrl ?? null,
			input.workItemStatus ?? null,
			JSON.stringify(input.workItemSnapshot ?? {}),
			now,
			now,
		],
	});

	return { id, status, createdAt: now };
}

export async function createAttempt(
	client: Client,
	input: CreateAttemptInput,
): Promise<CreatedAttempt> {
	const now = input.now ?? Date.now();
	const id = input.id ?? createPrefixedId("att");
	const status = input.status ?? "pending";

	await client.execute({
		sql: `
			INSERT INTO attempts (
				id,
				run_id,
				attempt_number,
				status,
				sandbox_id,
				command,
				created_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			id,
			input.runId,
			input.attemptNumber,
			status,
			input.sandboxId ?? null,
			input.command ?? null,
			now,
			now,
		],
	});

	return { id, status, createdAt: now };
}

export async function createEvent(
	client: Client,
	input: CreateEventInput,
): Promise<CreatedEvent> {
	const now = input.now ?? Date.now();
	const id = input.id ?? createPrefixedId("evt");
	const level = input.level ?? "info";

	await client.execute({
		sql: `
			INSERT INTO events (
				id,
				run_id,
				attempt_id,
				level,
				type,
				message,
				data_json,
				created_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			id,
			input.runId ?? null,
			input.attemptId ?? null,
			level,
			input.type,
			input.message ?? null,
			input.data === undefined ? null : JSON.stringify(input.data),
			now,
		],
	});

	return { id, level, createdAt: now };
}

function createPrefixedId(prefix: "claim" | "run" | "att" | "evt") {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function mapRun(row: Row): StateStoreRun {
	return {
		id: getString(row, "id"),
		workItemId: getString(row, "work_item_id"),
		claimToken: getString(row, "claim_token"),
		status: getString(row, "status") as RunStatus,
		workItemTitle: getString(row, "work_item_title"),
		workItemUrl: getNullableString(row, "work_item_url"),
		workItemStatus: getNullableString(row, "work_item_status"),
		workItemSnapshot: parseJsonValue(getString(row, "work_item_snapshot_json")),
		createdAt: getNumber(row, "created_at"),
		updatedAt: getNumber(row, "updated_at"),
		startedAt: getNullableNumber(row, "started_at"),
		finishedAt: getNullableNumber(row, "finished_at"),
	};
}

function mapAttempt(row: Row): StateStoreAttempt {
	return {
		id: getString(row, "id"),
		runId: getString(row, "run_id"),
		attemptNumber: getNumber(row, "attempt_number"),
		status: getString(row, "status") as AttemptStatus,
		sandboxId: getNullableString(row, "sandbox_id"),
		command: getNullableString(row, "command"),
		exitCode: getNullableNumber(row, "exit_code"),
		createdAt: getNumber(row, "created_at"),
		updatedAt: getNumber(row, "updated_at"),
		startedAt: getNullableNumber(row, "started_at"),
		finishedAt: getNullableNumber(row, "finished_at"),
	};
}

function mapEvent(row: Row): StateStoreEvent {
	return {
		id: getString(row, "id"),
		runId: getNullableString(row, "run_id"),
		attemptId: getNullableString(row, "attempt_id"),
		level: getString(row, "level") as EventLevel,
		type: getString(row, "type"),
		message: getNullableString(row, "message"),
		data: parseNullableJsonValue(getNullableString(row, "data_json")),
		createdAt: getNumber(row, "created_at"),
	};
}

function mapClaim(row: Row): StateStoreClaim {
	return {
		workItemId: getString(row, "work_item_id"),
		claimToken: getString(row, "claim_token"),
		claimedBy: getString(row, "claimed_by"),
		runId: getNullableString(row, "run_id"),
		workItemStatus: getNullableString(row, "work_item_status"),
		claimExpiresAt: getNumber(row, "claim_expires_at"),
		createdAt: getNumber(row, "created_at"),
		updatedAt: getNumber(row, "updated_at"),
	};
}

function mapCountRows(rows: Row[]): Record<string, number> {
	return Object.fromEntries(rows.map((row) => [getString(row, "status"), getNumber(row, "count")]));
}

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

function parseJsonValue(value: string): unknown {
	return JSON.parse(value);
}

function parseNullableJsonValue(value: string | null): unknown {
	return value === null ? null : JSON.parse(value);
}
