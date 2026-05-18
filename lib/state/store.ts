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

function createPrefixedId(prefix: "run" | "att" | "evt") {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
