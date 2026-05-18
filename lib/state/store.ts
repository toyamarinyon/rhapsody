import type { Client } from "@libsql/client";

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
