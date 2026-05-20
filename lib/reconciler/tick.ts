import type { Client } from "@libsql/client";

import { loadRhapsodyConfig } from "@/lib/config";
import {
	createStateStoreClient,
	listStaleRunningAttempts,
	reconcileStaleRunningAttempt,
	type ReconcileStaleRunningAttemptResult,
	type StaleRunningAttempt,
} from "@/lib/state";

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

	for (const attempt of staleAttempts) {
		results.push(
			await reconcileStaleRunningAttempt(client, {
				runId: attempt.runId,
				attemptId: attempt.attemptId,
				now,
				reason: "running_attempt_age_exceeded",
				maxRunningAttemptAgeMs,
			}),
		);
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
	};
}
