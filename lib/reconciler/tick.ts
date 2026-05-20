import type { Client } from "@libsql/client";

import { loadRhapsodyConfig } from "@/lib/config";
import {
	createStateStoreClient,
	listStaleRunningAttempts,
	reconcileStaleRunningAttempt,
	type ReconcileStaleRunningAttemptResult,
	type StaleRunningAttempt,
} from "@/lib/state";
import { getRun } from "workflow/api";

const DEFAULT_RUNNING_ATTEMPT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_RECONCILER_LIMIT = 20;

export type ReconcilerTickInput = {
	now?: number;
	maxRunningAttemptAgeMs?: number;
	limit?: number;
	client?: Client;
};

export type ReconcilerTickResponse = {
	scanned: number;
	reconciled: number;
	skipped: number;
	limits: {
		maxRunningAttemptAgeMs: number;
		limit: number;
		cutoff: number;
	};
	staleAttempts: StaleRunningAttempt[];
	results: ReconcileStaleRunningAttemptResult[];
	workflowCancellations: ReconcilerWorkflowCancellationResult[];
};

export type ReconcilerWorkflowCancellationResult =
	| {
			attempted: false;
			runId: string;
			attemptId: string;
			reason: "not_reconciled" | "missing_workflow_run_id";
	  }
	| {
			attempted: true;
			runId: string;
			attemptId: string;
			runnerWorkflowRunId: string;
			cancelled: true;
	  }
	| {
			attempted: true;
			runId: string;
			attemptId: string;
			runnerWorkflowRunId: string;
			cancelled: false;
			error: { name: string; message: string };
	  };

export async function runReconcilerTick(input: ReconcilerTickInput = {}): Promise<ReconcilerTickResponse> {
	const client = input.client ?? createStateStoreClient();

	try {
		return await runReconcilerTickWithClient(client, input);
	} finally {
		if (!input.client) {
			client.close();
		}
	}
}

async function runReconcilerTickWithClient(
	client: Client,
	input: Omit<ReconcilerTickInput, "client">,
): Promise<ReconcilerTickResponse> {
	const config = loadRhapsodyConfig();
	const now = input.now ?? Date.now();
	const maxRunningAttemptAgeMs =
		input.maxRunningAttemptAgeMs ??
		config.scheduler.runningAttemptTimeoutMs ??
		DEFAULT_RUNNING_ATTEMPT_TIMEOUT_MS;
	const limit = input.limit ?? DEFAULT_RECONCILER_LIMIT;
	const cutoff = now - maxRunningAttemptAgeMs;
	const staleAttempts = await listStaleRunningAttempts(client, { cutoff, limit });
	const results: ReconcileStaleRunningAttemptResult[] = [];
	const workflowCancellations: ReconcilerWorkflowCancellationResult[] = [];

	for (const attempt of staleAttempts) {
		const result = await reconcileStaleRunningAttempt(client, {
			runId: attempt.runId,
			attemptId: attempt.attemptId,
			now,
			reason: "running_attempt_age_exceeded",
			maxRunningAttemptAgeMs,
		});
		results.push(result);
		workflowCancellations.push(await cancelRunnerWorkflowForReconciledAttempt(result));
	}

	const reconciled = results.filter((result) => result.applied).length;

	return {
		scanned: staleAttempts.length,
		reconciled,
		skipped: results.length - reconciled,
		limits: {
			maxRunningAttemptAgeMs,
			limit,
			cutoff,
		},
		staleAttempts,
		results,
		workflowCancellations,
	};
}

async function cancelRunnerWorkflowForReconciledAttempt(
	result: ReconcileStaleRunningAttemptResult,
): Promise<ReconcilerWorkflowCancellationResult> {
	if (!result.applied) {
		return {
			attempted: false,
			runId: result.runId,
			attemptId: result.attemptId,
			reason: "not_reconciled",
		};
	}

	if (!result.runnerWorkflowRunId) {
		return {
			attempted: false,
			runId: result.runId,
			attemptId: result.attemptId,
			reason: "missing_workflow_run_id",
		};
	}

	try {
		const run = getRun(result.runnerWorkflowRunId);
		await run.cancel();
		return {
			attempted: true,
			runId: result.runId,
			attemptId: result.attemptId,
			runnerWorkflowRunId: result.runnerWorkflowRunId,
			cancelled: true,
		};
	} catch (error) {
		return {
			attempted: true,
			runId: result.runId,
			attemptId: result.attemptId,
			runnerWorkflowRunId: result.runnerWorkflowRunId,
			cancelled: false,
			error: serializeError(error),
		};
	}
}

function serializeError(error: unknown) {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}

	return { name: "UnknownError", message: String(error) };
}
