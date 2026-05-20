import type { Client, Transaction } from "@libsql/client";
import type { Row } from "@libsql/client";
import type { RhapsodyRunner } from "@/lib/config";

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
	runner: RhapsodyRunner;
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
	gitBranchName?: string | null;
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
	runner: RhapsodyRunner;
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
	runner: RhapsodyRunner;
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
	runner: RhapsodyRunner;
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
	runner: RhapsodyRunner;
	runnerWorkflowRunId: string | null;
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
	gitBranchName: string | null;
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

export type AttemptExecutionStatus = "completed" | "failed" | "timed_out" | "stopped";

export type AttemptStartInput = {
	runId: string;
	attemptId: string;
	claimToken: string;
	gitBranchName?: string | null;
	startedAt?: number | null;
	sandboxId?: string | null;
	command?: string | null;
	now?: number;
	eventId?: string;
};

export type AttemptTerminalCallbackInput = {
	runId: string;
	attemptId: string;
	claimToken: string;
	executionStatus: string;
	exitCode?: number | null;
	startedAt?: number | null;
	completedAt?: number | null;
	sandboxId?: string | null;
	command?: string | null;
	error?: string | null;
	now?: number;
	eventId?: string;
};

export type AttemptTransitionNotAppliedReason =
	| "run_not_found"
	| "attempt_not_found"
	| "claim_not_found"
	| "claim_mismatch"
	| "claim_expired"
	| "run_terminal"
	| "attempt_terminal";

export type AttemptTransitionApplied = {
	applied: true;
	idempotent: boolean;
	runStatus: RunStatus;
	attemptStatus: AttemptStatus;
	eventId: string | null;
	updatedAt: number;
};

export type AttemptTransitionNotApplied = {
	applied: false;
	reason: AttemptTransitionNotAppliedReason;
	runStatus?: RunStatus;
	attemptStatus?: AttemptStatus;
};

export type AttemptTransitionResult = AttemptTransitionApplied | AttemptTransitionNotApplied;

export type AttemptCallbackAcceptance =
	| {
			ok: true;
			runStatus: RunStatus;
			attemptStatus: AttemptStatus;
	  }
	| {
			ok: false;
			reason:
				| "run_not_found"
				| "attempt_not_found"
				| "claim_mismatch"
				| "sandbox_mismatch"
				| "attempt_terminal"
				| "run_terminal";
			runStatus?: RunStatus;
			attemptStatus?: AttemptStatus;
	  };

export type ClaimReleaseInput = {
	runId: string;
	claimToken: string;
	now?: number;
	eventId?: string;
};

export type ClaimReleaseNotAppliedReason = "run_not_found" | "claim_not_found" | "claim_mismatch";

export type ClaimReleaseResult =
	| {
			released: true;
			eventId: string;
			releasedAt: number;
	  }
	| {
			released: false;
			reason: ClaimReleaseNotAppliedReason;
			runStatus?: RunStatus;
	  };

export type SetRunnerWorkflowRunIdInput = {
	runId: string;
	runnerWorkflowRunId: string;
	now?: number;
};

export type SetRunnerWorkflowRunIdResult =
	| {
			updated: true;
			runId: string;
			runnerWorkflowRunId: string;
			updatedAt: number;
	  }
	| {
			updated: false;
			reason: "run_not_found";
	  };

export type StaleRunningAttempt = {
	runId: string;
	attemptId: string;
	workItemId: string;
	claimToken: string;
	attemptStartedAt: number | null;
	attemptUpdatedAt: number;
	sandboxId: string | null;
	command: string | null;
	claimExpiresAt: number | null;
};

export type ListStaleRunningAttemptsInput = {
	cutoff: number;
	limit: number;
};

export type ReconcileStaleRunningAttemptInput = {
	runId: string;
	attemptId: string;
	now?: number;
	eventId?: string;
	reason: string;
	maxRunningAttemptAgeMs: number;
};

export type ReconcileStaleRunningAttemptResult =
	| {
			applied: true;
			runId: string;
			attemptId: string;
			runStatus: RunStatus;
			attemptStatus: AttemptStatus;
			runnerWorkflowRunId: string | null;
			claimReleased: boolean;
			eventId: string;
			updatedAt: number;
	  }
	| {
			applied: false;
			runId: string;
			attemptId: string;
			reason: "not_found" | "not_running";
			runStatus?: RunStatus;
			attemptStatus?: AttemptStatus;
	  };

export async function getRunDetail(client: Client, runId: string): Promise<RunDetail | null> {
	const runResult = await client.execute({
		sql: `
			SELECT
				id,
				work_item_id,
				claim_token,
				runner,
				runner_workflow_run_id,
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
					git_branch_name,
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

export async function validateAttemptCanReceiveCallback(
	client: Client,
	input: { runId: string; attemptId: string; claimToken: string; sandboxId?: string | null },
): Promise<AttemptCallbackAcceptance> {
	const result = await client.execute({
		sql: `
			SELECT
				runs.claim_token AS claim_token,
				runs.status AS run_status,
				attempts.status AS attempt_status,
				attempts.sandbox_id AS attempt_sandbox_id
			FROM runs
			LEFT JOIN attempts
				ON attempts.run_id = runs.id
				AND attempts.id = ?
			WHERE runs.id = ?
			LIMIT 1
		`,
		args: [input.attemptId, input.runId],
	});
	const row = result.rows[0];

	if (!row) {
		return { ok: false, reason: "run_not_found" };
	}

	const runStatus = getString(row, "run_status") as RunStatus;
	const claimToken = getString(row, "claim_token");
	const attemptStatus = getNullableString(row, "attempt_status") as AttemptStatus | null;
	const attemptSandboxId = getNullableString(row, "attempt_sandbox_id");

	if (!attemptStatus) {
		return { ok: false, reason: "attempt_not_found", runStatus };
	}

	if (claimToken !== input.claimToken) {
		return { ok: false, reason: "claim_mismatch", runStatus, attemptStatus };
	}

	if (input.sandboxId && attemptSandboxId && attemptSandboxId !== input.sandboxId) {
		return { ok: false, reason: "sandbox_mismatch", runStatus, attemptStatus };
	}

	if (isTerminalAttemptStatus(attemptStatus)) {
		return { ok: false, reason: "attempt_terminal", runStatus, attemptStatus };
	}

	if (isTerminalRunStatus(runStatus)) {
		return { ok: false, reason: "run_terminal", runStatus, attemptStatus };
	}

	return { ok: true, runStatus, attemptStatus };
}

export async function listStaleRunningAttempts(
	client: Client,
	input: ListStaleRunningAttemptsInput,
): Promise<StaleRunningAttempt[]> {
	const result = await client.execute({
		sql: `
			SELECT
				runs.id AS run_id,
				attempts.id AS attempt_id,
				runs.work_item_id AS work_item_id,
				runs.claim_token AS claim_token,
				attempts.started_at AS attempt_started_at,
				attempts.updated_at AS attempt_updated_at,
				attempts.sandbox_id AS sandbox_id,
				attempts.command AS command,
				claims.claim_expires_at AS claim_expires_at
			FROM attempts
			INNER JOIN runs
				ON runs.id = attempts.run_id
			LEFT JOIN claims
				ON claims.work_item_id = runs.work_item_id
				AND claims.run_id = runs.id
				AND claims.claim_token = runs.claim_token
			WHERE attempts.status = 'running'
				AND runs.status = 'running'
				AND COALESCE(attempts.started_at, attempts.updated_at) <= ?
			ORDER BY COALESCE(attempts.started_at, attempts.updated_at) ASC
			LIMIT ?
		`,
		args: [input.cutoff, input.limit],
	});

	return result.rows.map((row) => ({
		runId: getString(row, "run_id"),
		attemptId: getString(row, "attempt_id"),
		workItemId: getString(row, "work_item_id"),
		claimToken: getString(row, "claim_token"),
		attemptStartedAt: getNullableNumber(row, "attempt_started_at"),
		attemptUpdatedAt: getNumber(row, "attempt_updated_at"),
		sandboxId: getNullableString(row, "sandbox_id"),
		command: getNullableString(row, "command"),
		claimExpiresAt: getNullableNumber(row, "claim_expires_at"),
	}));
}

export async function reconcileStaleRunningAttempt(
	client: Client,
	input: ReconcileStaleRunningAttemptInput,
): Promise<ReconcileStaleRunningAttemptResult> {
	const now = input.now ?? Date.now();
	const eventId = input.eventId ?? createPrefixedId("evt");
	const tx = await client.transaction("write");

	try {
		const result = await tx.execute({
			sql: `
				SELECT
					runs.id AS run_id,
					runs.status AS run_status,
					runs.runner_workflow_run_id AS runner_workflow_run_id,
					runs.work_item_id AS work_item_id,
					runs.claim_token AS claim_token,
					attempts.id AS attempt_id,
					attempts.status AS attempt_status,
					attempts.started_at AS attempt_started_at,
					attempts.updated_at AS attempt_updated_at,
					attempts.sandbox_id AS sandbox_id,
					attempts.command AS command,
					claims.claim_token AS active_claim_token
				FROM runs
				LEFT JOIN attempts
					ON attempts.run_id = runs.id
					AND attempts.id = ?
				LEFT JOIN claims
					ON claims.work_item_id = runs.work_item_id
					AND claims.run_id = runs.id
					AND claims.claim_token = runs.claim_token
				WHERE runs.id = ?
				LIMIT 1
			`,
			args: [input.attemptId, input.runId],
		});
		const row = result.rows[0];

		if (!row || getNullableString(row, "attempt_id") === null) {
			await tx.commit();
			return {
				applied: false,
				runId: input.runId,
				attemptId: input.attemptId,
				reason: "not_found",
			};
		}

		const runStatus = getString(row, "run_status") as RunStatus;
		const attemptStatus = getString(row, "attempt_status") as AttemptStatus;

		if (runStatus !== "running" || attemptStatus !== "running") {
			await tx.commit();
			return {
				applied: false,
				runId: input.runId,
				attemptId: input.attemptId,
				reason: "not_running",
				runStatus,
				attemptStatus,
			};
		}

		await tx.execute({
			sql: `
				UPDATE attempts
				SET
					status = ?,
					finished_at = COALESCE(finished_at, ?),
					updated_at = ?
				WHERE id = ? AND run_id = ? AND status = 'running'
			`,
			args: ["timed_out", now, now, input.attemptId, input.runId],
		});

		await tx.execute({
			sql: `
				UPDATE runs
				SET
					status = ?,
					finished_at = COALESCE(finished_at, ?),
					updated_at = ?
				WHERE id = ? AND status = 'running'
			`,
			args: ["timed_out", now, now, input.runId],
		});

		const workItemId = getString(row, "work_item_id");
		const claimToken = getString(row, "claim_token");
		const activeClaimToken = getNullableString(row, "active_claim_token");
		let claimReleased = false;

		if (activeClaimToken === claimToken) {
			await tx.execute({
				sql: "DELETE FROM claims WHERE work_item_id = ? AND run_id = ? AND claim_token = ?",
				args: [workItemId, input.runId, claimToken],
			});
			claimReleased = true;
		}

		await insertEvent(tx, {
			id: eventId,
			runId: input.runId,
			attemptId: input.attemptId,
			level: "warn",
			type: "reconciler.attempt_timed_out",
			message: "Reconciler marked stale running attempt as timed_out.",
			data: {
				reason: input.reason,
				maxRunningAttemptAgeMs: input.maxRunningAttemptAgeMs,
				attemptStartedAt: getNullableNumber(row, "attempt_started_at"),
				attemptUpdatedAt: getNumber(row, "attempt_updated_at"),
				sandboxId: getNullableString(row, "sandbox_id"),
				command: getNullableString(row, "command"),
				claimReleased,
			},
			now,
		});

		await tx.commit();

			return {
				applied: true,
				runId: input.runId,
				attemptId: input.attemptId,
				runStatus: "timed_out",
				attemptStatus: "timed_out",
				runnerWorkflowRunId: getNullableString(row, "runner_workflow_run_id"),
				claimReleased,
				eventId,
				updatedAt: now,
			};
	} catch (error) {
		await tx.rollback();
		throw error;
	} finally {
		tx.close();
	}
}

export async function releaseClaimForRun(client: Client, input: ClaimReleaseInput): Promise<ClaimReleaseResult> {
	const now = input.now ?? Date.now();
	const eventId = input.eventId ?? createPrefixedId("evt");
	const tx = await client.transaction("write");

	try {
		const result = await tx.execute({
			sql: `
				SELECT
					runs.id AS run_id,
					runs.status AS run_status,
					claims.work_item_id AS claim_work_item_id,
					claims.claim_token AS claim_token,
					claims.run_id AS claim_run_id
				FROM runs
				LEFT JOIN claims
					ON claims.work_item_id = runs.work_item_id
				WHERE runs.id = ?
				LIMIT 1
			`,
			args: [input.runId],
		});
		const row = result.rows[0];

		if (!row) {
			await tx.commit();
			return { released: false, reason: "run_not_found" };
		}

		const runStatus = getString(row, "run_status") as RunStatus;
		const claimWorkItemId = getNullableString(row, "claim_work_item_id");
		const claimToken = getNullableString(row, "claim_token");
		const claimRunId = getNullableString(row, "claim_run_id");

		if (claimWorkItemId === null || claimToken === null || claimRunId === null) {
			await tx.commit();
			return { released: false, reason: "claim_not_found", runStatus };
		}

		if (claimToken !== input.claimToken || claimRunId !== input.runId) {
			await tx.commit();
			return { released: false, reason: "claim_mismatch", runStatus };
		}

		await tx.execute({
			sql: "DELETE FROM claims WHERE work_item_id = ? AND claim_token = ? AND run_id = ?",
			args: [claimWorkItemId, input.claimToken, input.runId],
		});

		await insertEvent(tx, {
			id: eventId,
			runId: input.runId,
			attemptId: null,
			level: "info",
			type: "claim.released",
			message: "Claim released.",
			data: { workItemId: claimWorkItemId },
			now,
		});

		await tx.commit();
		return { released: true, eventId, releasedAt: now };
	} catch (error) {
		await tx.rollback();
		throw error;
	} finally {
		tx.close();
	}
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

export async function markAttemptStarted(
	client: Client,
	input: AttemptStartInput,
): Promise<AttemptTransitionResult> {
	const now = input.now ?? Date.now();
	const startedAt = input.startedAt ?? now;
	const eventId = input.eventId ?? createPrefixedId("evt");
	const tx = await client.transaction("write");

	try {
		const validation = await validateAttemptTransition(tx, input, now);

		if (!validation.ok) {
			await tx.commit();
			return validation.result;
		}

		const { run, attempt } = validation;

		if (attempt.status === "running" && run.status === "running") {
			await tx.commit();
			return {
				applied: true,
				idempotent: true,
				runStatus: "running",
				attemptStatus: "running",
				eventId: null,
				updatedAt: now,
			};
		}

		await tx.execute({
			sql: `
				UPDATE attempts
				SET
					status = ?,
					git_branch_name = COALESCE(?, git_branch_name),
					sandbox_id = COALESCE(?, sandbox_id),
					command = COALESCE(?, command),
					started_at = COALESCE(started_at, ?),
					updated_at = ?
				WHERE id = ? AND run_id = ?
			`,
			args: [
				"running",
				input.gitBranchName ?? null,
				input.sandboxId ?? null,
				input.command ?? null,
				startedAt,
				now,
				input.attemptId,
				input.runId,
			],
		});

		await tx.execute({
			sql: `
				UPDATE runs
				SET
					status = ?,
					started_at = COALESCE(started_at, ?),
					updated_at = ?
				WHERE id = ?
			`,
			args: ["running", startedAt, now, input.runId],
		});

		await insertEvent(tx, {
			id: eventId,
			runId: input.runId,
			attemptId: input.attemptId,
			level: "info",
			type: "attempt.started",
			message: "Attempt started.",
			data: {
				sandboxId: input.sandboxId ?? null,
				command: input.command ?? null,
				startedAt,
			},
			now,
		});

		await tx.commit();

		return {
			applied: true,
			idempotent: false,
			runStatus: "running",
			attemptStatus: "running",
			eventId,
			updatedAt: now,
		};
	} catch (error) {
		await tx.rollback();
		throw error;
	} finally {
		tx.close();
	}
}

export async function applyAttemptTerminalCallback(
	client: Client,
	input: AttemptTerminalCallbackInput,
): Promise<AttemptTransitionResult> {
	const now = input.now ?? Date.now();
	const completedAt = input.completedAt ?? now;
	const startedAt = input.startedAt ?? null;
	const eventId = input.eventId ?? createPrefixedId("evt");
	const { runStatus, attemptStatus } = evaluateTerminalStatus(input.executionStatus, input.exitCode ?? null);
	const tx = await client.transaction("write");

	try {
		const validation = await validateAttemptTransition(tx, input, now, { allowTerminalAttempt: true });

		if (!validation.ok) {
			await tx.commit();
			return validation.result;
		}

		const { run, attempt } = validation;

		if (isTerminalAttemptStatus(attempt.status)) {
			await tx.commit();
			return {
				applied: true,
				idempotent: true,
				runStatus: run.status,
				attemptStatus: attempt.status,
				eventId: null,
				updatedAt: now,
			};
		}

		await tx.execute({
			sql: `
				UPDATE attempts
				SET
					status = ?,
					sandbox_id = COALESCE(?, sandbox_id),
					command = COALESCE(?, command),
					exit_code = ?,
					started_at = COALESCE(started_at, ?),
					finished_at = COALESCE(finished_at, ?),
					updated_at = ?
				WHERE id = ? AND run_id = ?
			`,
			args: [
				attemptStatus,
				input.sandboxId ?? null,
				input.command ?? null,
				input.exitCode ?? null,
				startedAt ?? completedAt,
				completedAt,
				now,
				input.attemptId,
				input.runId,
			],
		});

		await tx.execute({
			sql: `
				UPDATE runs
				SET
					status = ?,
					started_at = COALESCE(started_at, ?),
					finished_at = COALESCE(finished_at, ?),
					updated_at = ?
				WHERE id = ?
			`,
			args: [runStatus, startedAt ?? completedAt, completedAt, now, input.runId],
		});

		await insertEvent(tx, {
			id: eventId,
			runId: input.runId,
			attemptId: input.attemptId,
			level: attemptStatus === "completed" ? "info" : "error",
			type: "attempt.terminal_callback",
			message: `Attempt callback recorded as ${attemptStatus}.`,
			data: {
				executionStatus: input.executionStatus,
				exitCode: input.exitCode ?? null,
				sandboxId: input.sandboxId ?? null,
				command: input.command ?? null,
				startedAt,
				completedAt,
				error: input.error ?? null,
			},
			now,
		});

		await tx.commit();

		return {
			applied: true,
			idempotent: false,
			runStatus,
			attemptStatus,
			eventId,
			updatedAt: now,
		};
	} catch (error) {
		await tx.rollback();
		throw error;
	} finally {
		tx.close();
	}
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
					runner,
					status,
					work_item_title,
					work_item_url,
					work_item_status,
					work_item_snapshot_json,
					created_at,
					updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`,
			args: [
				runId,
				input.workItemId,
				claimToken,
				input.runner,
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
					git_branch_name,
					created_at,
					updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?)
			`,
			args: [attemptId, runId, 1, "pending", null, now, now],
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
				JSON.stringify({ workItemId: input.workItemId, claimedBy: input.claimedBy, runner: input.runner }),
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
			runner: input.runner,
			createdAt: now,
		};
	} catch (error) {
		await tx.rollback();
		throw error;
	} finally {
		tx.close();
	}
}

export async function setRunnerWorkflowRunId(
	client: Client,
	input: SetRunnerWorkflowRunIdInput,
): Promise<SetRunnerWorkflowRunIdResult> {
	const now = input.now ?? Date.now();
	const result = await client.execute({
		sql: `
			UPDATE runs
			SET
				runner_workflow_run_id = ?,
				updated_at = ?
			WHERE id = ?
		`,
		args: [input.runnerWorkflowRunId, now, input.runId],
	});

	if ((result.rowsAffected ?? 0) < 1) {
		return {
			updated: false,
			reason: "run_not_found",
		};
	}

	return {
		updated: true,
		runId: input.runId,
		runnerWorkflowRunId: input.runnerWorkflowRunId,
		updatedAt: now,
	};
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
				runner,
				status,
				work_item_title,
				work_item_url,
				work_item_status,
				work_item_snapshot_json,
				created_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			id,
			input.workItemId,
			input.claimToken,
			input.runner,
			status,
			input.workItemTitle,
			input.workItemUrl ?? null,
			input.workItemStatus ?? null,
			JSON.stringify(input.workItemSnapshot ?? {}),
			now,
			now,
		],
	});

	return { id, status, runner: input.runner, createdAt: now };
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
				git_branch_name,
				sandbox_id,
				command,
				created_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
		`,
		args: [
			id,
			input.runId,
			input.attemptNumber,
			status,
			input.gitBranchName ?? null,
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

type TransitionValidationRow = {
	runId: string;
	runStatus: RunStatus;
	runClaimToken: string;
	workItemId: string;
	attemptId: string | null;
	attemptStatus: AttemptStatus | null;
	claimToken: string | null;
	claimRunId: string | null;
	claimExpiresAt: number | null;
};

type TransitionValidationResult =
	| {
			ok: true;
			run: { id: string; status: RunStatus };
			attempt: { id: string; status: AttemptStatus };
	  }
	| { ok: false; result: AttemptTransitionNotApplied };

async function validateAttemptTransition(
	client: Client | Transaction,
	input: { runId: string; attemptId: string; claimToken: string },
	now: number,
	options: { allowTerminalAttempt?: boolean } = {},
): Promise<TransitionValidationResult> {
	const result = await client.execute({
		sql: `
			SELECT
				runs.id AS run_id,
				runs.status AS run_status,
				runs.claim_token AS run_claim_token,
				runs.work_item_id AS work_item_id,
				attempts.id AS attempt_id,
				attempts.status AS attempt_status,
				claims.claim_token AS claim_token,
				claims.run_id AS claim_run_id,
				claims.claim_expires_at AS claim_expires_at
			FROM runs
			LEFT JOIN attempts
				ON attempts.run_id = runs.id
				AND attempts.id = ?
			LEFT JOIN claims
				ON claims.work_item_id = runs.work_item_id
			WHERE runs.id = ?
			LIMIT 1
		`,
		args: [input.attemptId, input.runId],
	});
	const row = result.rows[0];

	if (!row) {
		return { ok: false, result: { applied: false, reason: "run_not_found" } };
	}

	const validationRow: TransitionValidationRow = {
		runId: getString(row, "run_id"),
		runStatus: getString(row, "run_status") as RunStatus,
		runClaimToken: getString(row, "run_claim_token"),
		workItemId: getString(row, "work_item_id"),
		attemptId: getNullableString(row, "attempt_id"),
		attemptStatus: getNullableString(row, "attempt_status") as AttemptStatus | null,
		claimToken: getNullableString(row, "claim_token"),
		claimRunId: getNullableString(row, "claim_run_id"),
		claimExpiresAt: getNullableNumber(row, "claim_expires_at"),
	};

	if (validationRow.attemptId === null || validationRow.attemptStatus === null) {
		return {
			ok: false,
			result: { applied: false, reason: "attempt_not_found", runStatus: validationRow.runStatus },
		};
	}

	if (validationRow.claimToken === null || validationRow.claimRunId === null || validationRow.claimExpiresAt === null) {
		return {
			ok: false,
			result: {
				applied: false,
				reason: "claim_not_found",
				runStatus: validationRow.runStatus,
				attemptStatus: validationRow.attemptStatus,
			},
		};
	}

	if (
		input.claimToken !== validationRow.runClaimToken ||
		input.claimToken !== validationRow.claimToken ||
		input.runId !== validationRow.claimRunId
	) {
		return {
			ok: false,
			result: {
				applied: false,
				reason: "claim_mismatch",
				runStatus: validationRow.runStatus,
				attemptStatus: validationRow.attemptStatus,
			},
		};
	}

	if (validationRow.claimExpiresAt <= now) {
		return {
			ok: false,
			result: {
				applied: false,
				reason: "claim_expired",
				runStatus: validationRow.runStatus,
				attemptStatus: validationRow.attemptStatus,
			},
		};
	}

	if (
		isTerminalRunStatus(validationRow.runStatus) &&
		!(options.allowTerminalAttempt && isTerminalAttemptStatus(validationRow.attemptStatus))
	) {
		return {
			ok: false,
			result: {
				applied: false,
				reason: "run_terminal",
				runStatus: validationRow.runStatus,
				attemptStatus: validationRow.attemptStatus,
			},
		};
	}

	if (isTerminalAttemptStatus(validationRow.attemptStatus) && !options.allowTerminalAttempt) {
		return {
			ok: false,
			result: {
				applied: false,
				reason: "attempt_terminal",
				runStatus: validationRow.runStatus,
				attemptStatus: validationRow.attemptStatus,
			},
		};
	}

	return {
		ok: true,
		run: { id: validationRow.runId, status: validationRow.runStatus },
		attempt: { id: validationRow.attemptId, status: validationRow.attemptStatus },
	};
}

function evaluateTerminalStatus(
	executionStatus: string,
	exitCode: number | null,
): { runStatus: RunStatus; attemptStatus: AttemptStatus } {
	if (executionStatus === "completed" && exitCode === 0) {
		return { runStatus: "completed", attemptStatus: "completed" };
	}

	if (executionStatus === "timed_out") {
		return { runStatus: "timed_out", attemptStatus: "timed_out" };
	}

	if (executionStatus === "stopped") {
		return { runStatus: "canceled", attemptStatus: "canceled" };
	}

	return { runStatus: "failed", attemptStatus: "failed" };
}

type InsertEventInput = Required<Pick<CreateEventInput, "type">> & {
	id: string;
	runId: string | null;
	attemptId: string | null;
	level: EventLevel;
	message: string | null;
	data: unknown;
	now: number;
};

async function insertEvent(client: Client | Transaction, input: InsertEventInput) {
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
			input.id,
			input.runId,
			input.attemptId,
			input.level,
			input.type,
			input.message,
			JSON.stringify(input.data),
			input.now,
		],
	});
}

function isTerminalRunStatus(status: RunStatus) {
	return status === "completed" || status === "failed" || status === "canceled" || status === "timed_out" || status === "stale";
}

function isTerminalAttemptStatus(status: AttemptStatus) {
	return status === "completed" || status === "failed" || status === "canceled" || status === "timed_out" || status === "stale";
}

function createPrefixedId(prefix: "claim" | "run" | "att" | "evt") {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function mapRun(row: Row): StateStoreRun {
	return {
		id: getString(row, "id"),
		workItemId: getString(row, "work_item_id"),
		claimToken: getString(row, "claim_token"),
		runner: getString(row, "runner") as RhapsodyRunner,
		runnerWorkflowRunId: getNullableString(row, "runner_workflow_run_id"),
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
		gitBranchName: getNullableString(row, "git_branch_name"),
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
